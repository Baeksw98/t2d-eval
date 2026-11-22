"""GC sources: 채점·감사 검증 reports → the judgments physicians re-check (refactor of tools/build_gc_data.py).

Source format (unchanged): one report per patient × model, starting with
    # E11_<PID> · <model alias> 채점·감사 검증 자료
(the model alias is looked up in cases/models.json). Several reports may share a file.

Only judgments the AI audit flagged (△ minor / ✗ major) are exported: the AI Rater's other judgments were confirmed by
the audit and are not re-checked by physicians (human-in-the-loop on the ambiguous part only). Every judgment row still
counts toward concordance_base (n, met_raw, met_ai per TargetKey).
"""
import re

from .common import PATIENT_RE, rel

SCOPE = 'AI audit flagged (△/✗) judgments only'
_HEAD = re.compile(r'^# E11_(%s) · (.+?) 채점·감사 검증 자료' % PATIENT_RE)

# The audit / rubric notes are written against the scoring pipeline's internal record (field names, rule numbers).
# Physicians see these texts as they are (감사 의견, 감사 근거, 채점표 적용 근거, 채점표 감사 메모), so internal names
# are mapped to the labels used on screen. (field, on-screen label, label's last syllable has a final consonant)
FIELD_LABELS = [
    ('guideline_quotes', 'AI 채점이 인용한 채점 기준 문구(이 화면에는 표시하지 않음)', False),
    ('answer_quotes', 'AI 채점의 「인용한 답변」', True),
    ('combination_condition', '채점표 조합 조건', True),
    ('record_evidence', '채점표 기록 근거', False),
    ('reason', 'AI 채점의 「판정 사유」', False),
    ('decision', '결정', True),
]
PARTICLE = {'이': 0, '가': 0, '은': 1, '는': 1, '을': 2, '를': 2, '과': 3, '와': 3, '으로': 4, '로': 4}
PARTICLE_FORMS = [('이', '가'), ('은', '는'), ('을', '를'), ('과', '와'), ('으로', '로')]


def humanize(s):
    """Map pipeline-internal names and rule references in a display text to plain on-screen wording."""
    s = str(s or '')
    # prescription JSON quoted as evidence: "drug": "X" … "decision": "Y"  →  X (Y)
    s = re.sub(r'\s*…\s*"decision":\s*"([^"]*)"', r' (\1)', s)
    s = re.sub(r'"drug":\s*"([^"]*)"', r'\1', s)
    for field, label, batchim in FIELD_LABELS:
        def rep(m, label=label, batchim=batchim):
            p = m.group(1) or ''
            if p in PARTICLE:
                p = PARTICLE_FORMS[PARTICLE[p]][0 if batchim else 1]
            return label + p
        s = re.sub(r'(?<![A-Za-z_])' + field + r'(?![A-Za-z_])(으로|로|이|가|은|는|을|를|과|와)?', rep, s)
    s = re.sub(r'규칙\s*\d+\s*에\s*따라', '채점 원칙에 따라', s)
    s = re.sub(r'규칙\s*\d+', '채점 원칙', s)
    s = s.replace('(금지형 항목: 기록만으로 적용)', '(환자 기록만으로 적용 여부를 정하는 항목)')
    s = s.replace('금지형 규칙의 기록 확인', '환자 기록 확인')
    s = s.replace('금지형 항목', '환자 기록만으로 적용 여부를 정하는 항목')
    s = re.sub(r';\s*확정[^;〕]*\(작성\)', '', s)          # rubric-audit bookkeeping tail inside 〔…〕
    return s.strip()


def humanize_evidence(e):
    e = humanize(e)
    k = e.find('“')
    if k > 0:   # label part only: "가이드라인 ADA 2026 Sec 8 text; Sec 9 text" → "… Sec 8; Sec 9"
        e = re.sub(r'\s+text(?=\s*[;:,]|\s*$)', '', e[:k]) + e[k:]
    return e


_ELEM = re.compile(r'^\*\*(Q\d\.\d-\d\d) (.+?)\*\* — 감점 기준: (.+)$')
MAX_COMBOS = 3          # candidate regimens per CDSS answer (Phase 2 summary always lists 3)
_ROW = re.compile(r'^\| (조합 (\d)|Phase 1) \|')
_TABLE_HEAD = '| 단위 | 판정 |'
_AUDIT_FIX = re.compile(r'^[✗✘]\s*(?:→|->)\s*(충족|감점)')
ROW_CELLS = 8   # 단위 | 판정 | 유형 | 답 인용 | Rater 사유 | 감사 | 채점표 적용 근거 | 의사 검증


def _verdict(cell):
    """'○ 충족' → met, '−1 감점' → deducted (ASCII '-1' / en dash '–1' accepted), '채점하지 않음' → None, else ''."""
    c = cell.strip()
    if c.startswith('○'):
        return 'met'
    if re.match(r'^[−\-–]1(?!\d)', c):
        return 'deducted'
    if c.startswith('채점하지 않음'):
        return None
    return ''


def parse(path, models, problems):
    """Parse one report file. Returns [unit] with unit = {key, patient, model, run, items, conc, where, lines}.

    A report that deviates from the format in one place is reported (file:line), never silently mis-read:
    [bad-element] an element header line that is not '**Q2.1-02 제목** — 감점 기준: …'; [table-without-element] a judgment
    table with no element header of its own; [bad-row] a row of a judgment table without the 8 cells or with another unit
    label; [bad-verdict] a verdict other than ○ / −1 / 채점하지 않음; [bad-audit] an audit cell other than ✓ / △ … /
    ✗ → 충족|감점 …; [phase-mismatch] a Phase 1 row under a Phase 2–5 element (or a 조합 row under a Q1.x element).
    The element is reset at every heading and question header, so rows never attach to an earlier element.
    """
    lines = path.read_text(encoding='utf-8').split('\n')
    units, cur, elem, question = [], None, None, None
    qseen = {}
    in_table = False
    where = lambda n: '%s:%d' % (rel(path), n)
    for ln_no, ln in enumerate(lines, 1):
        m = _HEAD.match(ln)
        if m:
            code = models.code_of(m.group(2))
            in_table = False
            if not code:
                problems.error(where(ln_no), '보고서 제목의 모델 "%s" 을 cases/models.json 에서 찾을 수 없습니다 [unknown-model]' % m.group(2),
                               'cases/models.json 의 해당 모델 aliases 에 "%s" 를 넣으세요' % m.group(2))
                cur = None
                continue
            cur = {'patient': m.group(1), 'model': code, 'run': None, 'items': [], 'conc': {},
                   'where': where(ln_no), 'lines': {}}
            cur['key'] = cur['patient'] + '_' + cur['model']
            units.append(cur)
            elem = None
            question = None
            qseen = {}
            continue
        if not cur:
            continue
        if not ln.startswith('|'):
            in_table = False
        m = re.match(r'^실행 `([^`]+)`', ln)
        if m and not cur['run']:
            cur['run'] = m.group(1)
        if ln.startswith('#'):
            elem = None          # a heading ends the element (its rows never carry over to the next section)
        m = re.match(r'^### (\d\.\d) (.+)$', ln)
        if m:
            question = {'id': m.group(1), 'text': m.group(2).strip(), 'line': ln_no}
            qseen[question['id']] = question
            elem = None
            continue
        m = re.match(r'^\*\*(1\.\d) (.+)\*\*$', ln)
        if m:
            question = {'id': m.group(1), 'text': m.group(2).strip(), 'line': ln_no}
            qseen[question['id']] = question
            elem = None
            continue
        m = _ELEM.match(ln)
        if m:
            elem = {'id': m.group(1), 'title': m.group(2).strip(), 'criterion': m.group(3).strip(), 'line': ln_no, 'tables': 0,
                    'seen': set()}
            qid = elem['id'][1:4]
            # Phase 2–5: the element sits under its own "### x.y" header. Phase 1: both "**1.1 …**" and "**1.2 …**"
            # come first and their elements follow, so it is enough that the matching question appeared in this report.
            if (qid not in qseen) if qid.startswith('1.') else (not question or question['id'] != qid):
                problems.error(where(ln_no), '채점 항목 %s 위에 같은 번호의 질문 머리 줄이 없습니다%s [no-question]'
                               % (elem['id'], (' (지금 질문은 %s)' % question['id']) if question else ''),
                               'Phase 2–5 항목은 "### %s 질문 제목", Phase 1 항목은 "**%s 질문 제목**" 줄 아래에 두세요 — 항목 번호(Q%s-…)와 질문 번호가 같아야 합니다'
                               % (qid, qid, qid))
                elem = None
            continue
        if ln.startswith('**Q'):
            elem = None
            problems.error(where(ln_no), '채점 항목 제목 줄을 읽을 수 없습니다: "%s" [bad-element]' % ln[:60],
                           '형식: **Q2.1-02 제목** — 감점 기준: … (굵게 표시 ** 와 em dash "—" 를 그대로 쓰세요)')
            continue
        if ln.startswith(_TABLE_HEAD):
            if elem is None or elem['tables']:
                problems.error(where(ln_no), '판정 표 위에 이 표의 채점 항목 제목 줄이 없습니다 [table-without-element]',
                               '표 바로 위에 "**Q2.1-02 제목** — 감점 기준: …" 줄을 두세요')
                in_table = False
                elem = None
                continue
            elem['tables'] += 1
            in_table = True
            continue
        if not in_table:
            if elem is not None and _ROW.match(ln):
                problems.error(where(ln_no), '%s 의 판정 행이 판정 표 밖에 있습니다 — 표 머리 줄 "%s … |" 이 없거나 표가 빈 줄로 끊겼습니다 [bad-table]'
                               % (elem['id'], _TABLE_HEAD), '판정 표는 머리 줄, 구분 줄(| :-- |), 판정 행을 빈 줄 없이 이어서 쓰세요')
            continue
        if re.match(r'^\|\s*:?-', ln):      # | :-- | separator row
            continue
        m = _ROW.match(ln)
        cells = [c.strip() for c in ln.strip().strip('|').split(' | ')]
        if not m:
            problems.error(where(ln_no), '판정 표의 행을 읽을 수 없습니다 — 첫 칸은 "조합 1"–"조합 %d" 또는 "Phase 1" 이어야 합니다: "%s" [bad-row]'
                           % (3, ln[:50]), '판정 표의 열: 단위 | 판정 | 유형 | 답 인용 | Rater 사유 | 감사 | 채점표 적용 근거 | 의사 검증')
            continue
        if len(cells) != ROW_CELLS:
            problems.error(where(ln_no), '판정 표의 행이 %d칸입니다 (%d칸이어야 함) [bad-row]' % (len(cells), ROW_CELLS),
                           '열: 단위 | 판정 | 유형 | 답 인용 | Rater 사유 | 감사 | 채점표 적용 근거 | 의사 검증 — 칸 안의 "|" 는 지우거나 다른 기호로 바꾸세요')
            continue
        unit_label, verdict, typ, quotes, reason, audit, basis, _phys = cells
        combo = int(m.group(2)) if m.group(2) else 0
        if (combo == 0) != (elem['id'][1] == '1'):
            problems.error(where(ln_no), '%s 행이 %s 항목 아래에 있습니다 — Phase 1 항목(Q1.x)에는 "Phase 1" 행만, Phase 2–5 항목에는 "조합 N" 행만 [phase-mismatch]'
                           % (unit_label, elem['id']))
            continue
        if combo > MAX_COMBOS:
            problems.error(where(ln_no), '"%s" 행이 있습니다 — 답변마다 후보 조합은 %d개(조합 1–%d)입니다 [bad-combo]' % (unit_label, MAX_COMBOS, MAX_COMBOS))
            continue
        if combo in elem['seen']:
            problems.error(where(ln_no), '%s 의 판정 표에 "%s" 행이 두 번 있습니다 [dup-row]' % (elem['id'], unit_label),
                           '한 항목의 표에는 조합마다(또는 Phase 1) 한 행만 둡니다 — 조합 번호를 확인하세요')
            continue
        elem['seen'].add(combo)
        v = _verdict(verdict)
        if v == '':
            problems.error(where(ln_no), '판정 "%s" 을 읽을 수 없습니다 — "○ 충족", "−1 감점", "채점하지 않음" 중 하나 [bad-verdict]' % verdict[:20])
            continue
        if v is None:
            continue
        a = audit.strip()
        corrected = None
        am = _AUDIT_FIX.match(a)
        if am:
            corrected = 'met' if am.group(1) == '충족' else 'deducted'
        elif a[:1] in ('✗', '✘') or re.match(r'^[Xx]\s*(→|->|$)', a):
            problems.error(where(ln_no), '감사 칸 "%s" 을 읽을 수 없습니다 — 감사가 판정을 바꾸면 "✗ → 충족" 또는 "✗ → 감점" [bad-audit]' % a[:24])
            continue
        elif a and a not in ('–', '-') and a[0] not in '✓△':
            problems.error(where(ln_no), '감사 칸 "%s" 을 읽을 수 없습니다 — "✓", "△ …", "✗ → 충족 …", "✗ → 감점 …" 중 하나 [bad-audit]' % a[:24])
            continue
        if a[:1] == '✘':
            a = '✗' + a[1:]
        phase = 'P1' if combo == 0 else 'P' + elem['id'][1]
        tkey = cur['key'] + '|' + (phase if combo == 0 else 'C%d|%s' % (combo, phase))
        b = cur['conc'].setdefault(tkey, {'n': 0, 'met_raw': 0, 'met_ai': 0})
        b['n'] += 1
        b['met_raw'] += 1 if v == 'met' else 0
        b['met_ai'] += 1 if (corrected or v) == 'met' else 0
        if not a or a[0] not in '△✗':
            continue
        mark = 'major' if a[0] == '✗' else 'minor'
        body = re.sub(r'^(△|[✗✘]\s*(?:→|->)\s*(충족|감점))\s*', '', a)
        cm = re.match(r'^\[([^\]]+)\]\s*', body)
        category = cm.group(1) if cm else ''
        if not category:
            problems.error(where(ln_no), '감사 표시(%s) 뒤에 오류 유형 "[…]" 이 없습니다 [no-category]' % a[:1],
                           '형식: "△ [근거 불충분] 설명 〔근거〕" 또는 "✗ → 충족 [답변 내용 오독] 설명 〔근거〕"')
            continue
        body = body[cm.end():]
        # split audit explanation and its 〔evidence〕 quotes
        ev = re.findall(r'〔([^〕]+)〕', body)
        expl = humanize(re.sub(r'\s*〔[^〕]+〕', '', body).strip())
        ev = [humanize_evidence(e) for e in ev]
        qid = elem['id'][1:4]  # Q2.1-02 -> 2.1
        item_id = '%s|%s|%s' % (cur['key'], ('C%d' % combo) if combo else 'P1', elem['id'])
        qrec = qseen.get(qid)
        cur['lines'][item_id] = {'row': ln_no, 'element': elem['line'], 'question': qrec['line'] if qrec else elem['line']}
        cur['items'].append({
            'id': item_id,
            'unit': cur['key'],
            'patient': cur['patient'],
            'combo': combo,
            'question': qid,
            'question_text': qrec['text'] if qrec else '',
            'element': elem['id'],
            'title': elem['title'],
            'criterion': elem['criterion'],
            'rater': {
                'verdict': v,
                'type': '' if typ in ('', '–') else typ,
                'quotes': [] if quotes in ('', '–') else re.findall(r'“([^”]*)”(?:\s*\(답안 원문에서 찾지 못함\))?', quotes),
                'quotes_raw': '' if quotes in ('', '–') else quotes,
                'reason': humanize(reason),
            },
            'audit': {
                'mark': mark,
                'corrected': corrected,
                'category': category,
                'explanation': expl,
                'evidence': ev,
            },
            'final': corrected or v,
            'target_key': tkey,
            'basis': humanize(basis),
        })
    if not units:
        problems.warn(rel(path), '보고서 제목 줄을 찾지 못했습니다 — 형식: "# E11_P052 · <모델 별칭> 채점·감사 검증 자료" (가운뎃점 · ) [no-report-title]',
                      '이 파일의 판정은 하나도 읽지 않았습니다')
    return units


def unit_record(u):
    """The gc_items.js record of one unit (field order as in the committed data)."""
    return {'key': u['key'], 'patient': u['patient'], 'model': u['model'], 'run': u['run'], 'items': u['items'],
            'concordance_base': u['conc']}


def compact(gc_data, parts):
    """The backend copy of a set's GC data (GC_ITEMS in gas/GcCode.gs and gc/data/sets/<id>.json — the same shape):
    only the fields the backend needs (no criterion / explanation / quote texts), plus the Parts."""
    units = {}
    for key, u in gc_data['units'].items():
        items = []
        for it in u['items']:
            au, ra = it.get('audit') or {}, it.get('rater') or {}
            items.append({
                'id': it['id'], 'unit': it['unit'], 'patient': it['patient'], 'model': u['model'], 'combo': it['combo'],
                'question': it['question'], 'element': it['element'], 'title': it['title'], 'target_key': it['target_key'],
                'audit_mark': au.get('mark'), 'audit_category': au.get('category', ''), 'audit_corrected': au.get('corrected'),
                'rater_verdict': ra.get('verdict'), 'final': it['final'],
            })
        units[key] = {'key': u['key'], 'patient': u['patient'], 'model': u['model'],
                      'concordance_base': u['concordance_base'], 'items': items}
    return {
        'set_id': gc_data.get('set_id', 'v1'),
        'data_version': gc_data.get('data_version', ''),
        'scope': gc_data.get('scope', ''),
        'parts': [{'id': p['id'], 'sequences': p['sequences'], 'items': p.get('items'), 'minutes': p.get('minutes')} for p in parts],
        'units': units,
    }
