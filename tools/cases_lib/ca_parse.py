"""CA sources: CDSS output documents → patient vignettes + AI outputs (refactor of tools/parse_md.py + tools/build_data.py).

Source format (unchanged from the original upload, one or many .md files in cases/sources/ca/):
  <PID> <model alias>                     e.g. '# P051 Deepseek V4.1 Flash'       followed by the output JSON
  <model alias> <PID>                     e.g. 'GPT 6.1 Sol P011'                 followed by the output JSON
  <PID> Patient Input Information         followed by the patient record (### 인구통계 …)
A file may hold any number of these sections (the combined upload holds 4 outputs + 2 records; a file per patient × model,
with or without the record, works the same). '**' bold markers are removed first, as before. Model names are recognised
through cases/models.json aliases; a header-like line with an unknown model is reported, never silently skipped.
"""
import json
import re

from .common import PATIENT_RE, rel

TIMEPOINTS = ["12개월 전", "9개월 전", "6개월 전", "3개월 전", "현재"]
ANSWER_KEYS = ['2.1', '2.2', '2.3', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3',
               '5.1', '5.2', '5.3', '5.4']
N_COMBINATIONS = 3      # the instrument (and the CA sheet columns ComboSeen_1..3) assume three candidate regimens

_PAT_HEAD = re.compile(r'^(%s)\s+Patient Input Information$' % PATIENT_RE, re.I)
_PID_FIRST = re.compile(r'^(%s)\s+(.+)$' % PATIENT_RE)
_PID_LAST = re.compile(r'^(.+?)\s+(%s)$' % PATIENT_RE)


def _head_text(line):
    return line.strip().lstrip('#').strip()


def _next_nonblank(lines, i):
    for j in range(i + 1, min(len(lines), i + 6)):
        if lines[j].strip():
            return _head_text(lines[j])
    return ''


def scan_file(path, models, problems):
    """Return ([section], text) for one source file. section = (line_index, kind, pid, model_code, header_text)."""
    raw = path.read_text(encoding='utf-8')
    text = raw.replace('**', '')
    lines = text.split('\n')
    heads = []
    for i, l in enumerate(lines):
        s = _head_text(l)
        if not s or s[0] in '"{}[],':
            continue
        m = _PAT_HEAD.match(s)
        if m:
            heads.append((i, 'patient', m.group(1), None, s))
            continue
        m = _PID_FIRST.match(s)
        if m and models.code_of(m.group(2)):
            heads.append((i, 'output', m.group(1), models.code_of(m.group(2)), s))
            continue
        m2 = _PID_LAST.match(s)
        if m2 and models.code_of(m2.group(1)):
            heads.append((i, 'output', m2.group(2), models.code_of(m2.group(1)), s))
            continue
        # header-like line (patient id at the start or end, JSON right after) whose model is not in models.json
        if (m or m2) and len(s) <= 80 and _next_nonblank(lines, i).startswith(('{', '```')):
            name = m.group(2) if m else m2.group(1)
            problems.error('%s:%d' % (rel(path), i + 1),
                           '출력 제목 "%s" 의 모델 "%s" 을 cases/models.json 에서 찾을 수 없습니다 [unknown-model]' % (s, name),
                           'cases/models.json 에 이 모델을 추가하거나 기존 모델의 aliases 에 "%s" 를 넣으세요' % name)
            heads.append((i, 'unknown', m.group(1) if m else m2.group(2), None, s))
    return heads, lines


def parse_sources(files, models, problems):
    """Parse CA source files (in the given order).
    Returns (outputs, patients_raw, where): outputs {key: raw output JSON}, patients_raw {pid: record text},
    where {key or 'patient:PID': 'file:line'} — all in document order."""
    outputs, patients, where = {}, {}, {}
    for path in files:
        heads, lines = scan_file(path, models, problems)
        if not heads:
            problems.warn(rel(path), '출력·환자 기록 제목을 하나도 찾지 못했습니다 [no-sections]',
                          '제목 줄 형식: "P051 <모델 이름>", "<모델 이름> P051", "P051 Patient Input Information"')
        bounds = heads + [(len(lines), 'end', None, None, '')]
        for k in range(len(heads)):
            start, kind, pid, model, head = heads[k]
            end = bounds[k + 1][0]
            loc = '%s:%d' % (rel(path), start + 1)
            body = '\n'.join(lines[start + 1:end])
            if kind == 'output':
                key = '%s_%s' % (pid, model)
                off = body[:len(body) - len(body.lstrip())].count('\n')   # blank lines before the JSON (for the error line)
                body = body.strip()
                fence = re.match(r'^```[A-Za-z]*[ \t]*\n', body)          # a markdown code fence around the JSON (```json … ```)
                if fence:
                    off += 1
                    body = body[fence.end():]
                    close = body.find('\n```')
                    body = body[:close] if close >= 0 else re.sub(r'```\s*$', '', body)
                body = re.sub(r'^\s*#\s*\{', '{', body, count=1)   # the first block of the upload starts with '#  {'
                try:
                    obj = json.loads(body)
                except json.JSONDecodeError as e:
                    problems.error('%s:%d' % (rel(path), start + 1 + off + e.lineno), '%s 출력 JSON 을 읽을 수 없습니다: %s [bad-output-json]' % (key, e.msg),
                                   '이 제목("%s") 아래 JSON 의 쉼표·따옴표·괄호를 확인하세요 (```json … ``` 코드 블록 표시는 그대로 두어도 됩니다)' % head)
                    continue
                if key in outputs:
                    problems.error(loc, '%s 출력이 두 번 있습니다 (처음: %s) [duplicate-key]' % (key, where[key]),
                                   '같은 환자 × 모델은 한 번만 넣거나, 세트 매니페스트의 sources 로 쓸 파일을 고르세요')
                    continue
                outputs[key] = obj
                where[key] = loc
            elif kind == 'patient':
                rec = body.strip()
                if pid in patients:
                    if re.sub(r'\s+', ' ', patients[pid]) != re.sub(r'\s+', ' ', rec):
                        problems.error(loc, '환자 %s 기록이 두 번 있고 내용이 다릅니다 (처음: %s) [duplicate-patient]' % (pid, where['patient:' + pid]),
                                       '같은 환자의 기록은 한 가지만 두세요')
                    continue
                patients[pid] = rec
                where['patient:' + pid] = loc
    return outputs, patients, where


# ---------------------------------------------------------------------------------------------------------------
# Patient record → structured sections (unchanged logic of tools/build_data.py; failures become problems)
# ---------------------------------------------------------------------------------------------------------------
class _RecordError(Exception):
    pass


def parse_patient(pid, raw):
    secs, cur = {}, None
    for line in raw.split("\n"):
        s = line.rstrip()
        if not s.strip():
            continue
        m = re.match(r"^###\s*(.+?)\s*$", s.strip())
        if m:
            title = m.group(1)
            if ":" in title:
                k, v = title.split(":", 1)
                secs[k.strip()] = [v.strip()]
                cur = None
            else:
                cur = title
                secs[cur] = []
            continue
        if cur:
            secs[cur].append(s.strip())

    def sec(name):
        if name not in secs or (name in ('인구통계', '내원 유형', '신체검사(현재)') and not secs[name]):
            raise _RecordError('"### %s" 절이 없습니다' % name)
        return secs[name]

    p = {"id": pid}
    p["demographics"] = sec("인구통계")[0]
    p["visit_type"] = sec("내원 유형")[0]
    for l in sec("내원 이유/현재 증상"):
        if l.startswith("내원 이유:"):
            parts = [x.strip() for x in l[len("내원 이유:"):].split("|")]
            p["visit_reason"] = parts[0]
            for x in parts[1:]:
                if x.startswith("진단 경위:"):
                    p["diagnosis_history"] = x[len("진단 경위:"):].strip()
        elif l.startswith("현재 증상:"):
            p["symptoms"] = [x.strip() for x in l[len("현재 증상:"):].split(";") if x.strip()]
    hist = {}
    for l in sec("병력"):
        m = re.match(r"^-\s*(.+?):\s*(.+)$", l)
        if m:
            hist[m.group(1).strip()] = m.group(2).strip()
    p["history"] = {
        "other_conditions": [x.strip() for x in hist.get("기타 질환", "").split(";") if x.strip()],
        "dm_comorbidities": [x.strip() for x in hist.get("당뇨 관련 동반질환", "").split(";") if x.strip()],
        "family": hist.get("가족력", ""),
        "social": [x.strip() for x in hist.get("사회력", "").split(";") if x.strip()],
    }
    meds = []
    for l in sec("약물 정보"):
        m = re.match(r"^-\s*현재 복용약:\s*(.+)$", l)
        if m:
            meds = [x.strip() for x in m.group(1).split(";") if x.strip()]
    p["medications"] = meds
    p["exam"] = [x.strip() for x in sec("신체검사(현재)")[0].split(";") if x.strip()]
    labs, extra = [], []
    for l in sec("검사 수치(검사일/상대시점 포함)"):
        m = re.match(r"^-\s*(.+?):\s*(.+)$", l)
        if not m:
            continue
        group, body = m.group(1).strip(), m.group(2).strip()
        if group == "추가 검사":
            extra = [x.strip() for x in body.split(";") if x.strip()]
            continue
        for im in re.finditer(r"([^,;()]+?)\s*\(([^()]*)\)", body):
            name = im.group(1).strip().lstrip(",;").strip()
            vals = {}
            for part in im.group(2).split(";"):
                part = part.strip()
                for tp in TIMEPOINTS:
                    if part.startswith(tp + " "):
                        vals[tp] = part[len(tp) + 1:].strip()
            if len(vals) != 5:
                raise _RecordError('검사 "%s" 의 값이 5개 시점(%s)으로 읽히지 않습니다: %s' % (name, ' / '.join(TIMEPOINTS), vals))
            labs.append({"group": group, "name": name, "values": [vals[tp] for tp in TIMEPOINTS]})
    p["labs"] = labs
    p["labs_timepoints"] = TIMEPOINTS
    p["extra_tests"] = extra
    for l in sec("개별 치료 결정 요소"):
        if l.startswith("현재까지의 치료 순응도:"):
            body = l.split(":", 1)[1].strip()
            p["adherence"] = [x.strip() + ("" if x.strip().endswith(".") else ".") for x in re.split(r"(?<=[.])\s+", body) if x.strip()]
        elif l.startswith("환자의 경제적 여건:"):
            p["economics"] = l.split(":", 1)[1].strip()
    for k in ("visit_reason", "symptoms", "adherence", "economics"):
        if k not in p:
            raise _RecordError('항목 "%s" 를 찾지 못했습니다' % {'visit_reason': '내원 이유:', 'symptoms': '현재 증상:',
                                                            'adherence': '현재까지의 치료 순응도:', 'economics': '환자의 경제적 여건:'}[k])
    return p


def build_patients(patients_raw, where, problems):
    out = {}
    for pid, raw in patients_raw.items():
        try:
            out[pid] = parse_patient(pid, raw)
        except _RecordError as e:
            problems.error(where.get('patient:' + pid, pid), '환자 %s 기록: %s [bad-record]' % (pid, e),
                           '기존 기록(cases/sources/ca/2026-11-18_CDSS_P051_P011.md 의 "P051 Patient Input Information")과 같은 절·항목 이름을 쓰세요')
    return out


def build_output(key, raw, models):
    pid, model = key.split('_', 1)
    return {"key": key, "patient": pid, "model": model, "model_name": models.name_of(model),
            "phase_1": raw.get("phase_1"), "combinations": raw.get("combinations")}


def check_output(key, o, loc, problems):
    """Structure the CA screens rely on: Phase 1 (1.1 referral + answer, 1.2), three candidate regimens with a name,
    a prescription list and answers 2.1–5.4."""
    p1 = o.get('phase_1')
    if not isinstance(p1, dict) or not isinstance(p1.get('1.1'), dict) or 'referral' not in p1['1.1'] or 'answer' not in p1['1.1'] or '1.2' not in p1:
        problems.error(loc, '%s: phase_1 에 "1.1"(referral, answer)과 "1.2" 가 있어야 합니다 [bad-phase1]' % key)
    cs = o.get('combinations')
    if not isinstance(cs, list) or len(cs) != N_COMBINATIONS:
        problems.error(loc, '%s: combinations 는 후보 조합 %d개여야 합니다 (받은 수: %s) [combination-count]' %
                       (key, N_COMBINATIONS, len(cs) if isinstance(cs, list) else '없음'))
        return
    for i, c in enumerate(cs):
        w = '%s 조합 %d' % (key, i + 1)
        if not isinstance(c, dict):
            problems.error(loc, '%s: 객체가 아닙니다 [bad-combination]' % w)
            continue
        if not str(c.get('name') or '').strip():
            problems.error(loc, '%s: name 이 없습니다 [bad-combination]' % w)
        rx = c.get('prescription')
        if not isinstance(rx, list) or not rx or not all(isinstance(r, dict) and r.get('drug') and 'decision' in r for r in rx):
            problems.error(loc, '%s: prescription 은 drug·decision 이 있는 약물 목록이어야 합니다 [bad-prescription]' % w)
        ans = c.get('answers') if isinstance(c.get('answers'), dict) else {}
        missing = [k for k in ANSWER_KEYS if not str(ans.get(k) or '').strip()]
        if missing:
            problems.error(loc, '%s: answers 에 빈 문항이 있습니다: %s [missing-answers]' % (w, ', '.join(missing)),
                           'Phase 2–5 의 문항 %s 이 모두 있어야 합니다' % ' '.join(ANSWER_KEYS))
