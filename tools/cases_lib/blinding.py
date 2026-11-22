"""Blinding check: no model code, name, alias or run id in any text the evaluators see.

Evaluators must never learn which CDSS model wrote an answer (cases/models.json: names are analysis-only). The CA screens
show the patient record and every field of a model's output (Phase 1, combination names, prescriptions, answers 2.1–5.4);
the GC item screens show the element title and criterion, the rubric question, the AI rater's verdict type, quotes and
reason, the AI audit's category, explanation and evidence, and the rubric basis. Every one of these strings is scanned for

  - every model in cases/models.json (not only the set's): its name and aliases, matched ignoring case, spaces, hyphens and
    underscores ('GPT 6.1 Sol' = 'gpt-6.1-sol'), and its code as a whole word ('alpha' but not 'alphabet')
                                                                            → error  [model-name-in-text]
  - GC run ids ('20261118_ko_profile12_final_gpt61sol') and their model-specific fragments ('gpt61sol')
                                                                            → error  [run-id-in-text]
  - a generic code (not a vendor/model word) used as the first part of a compound word ('alpha-glucosidase', 'beta-cell')
                                                                            → check [model-code-compound]
    (a vendor/model code stays an error when hyphenated: 'DeepSeek-R1', 'GPT-based')
  - common vendor / product words (OpenAI, Claude, Gemini, …) not covered above           → check [vendor-name-in-text]

Each hit is reported with file:line (the source line that holds the text) and the field it is in.
"""
import json
import re

from .common import norm_alias

VENDOR_WORDS = ['openai', 'chatgpt', 'anthropic', 'claude', 'gemini', 'deepseek', 'llama', 'mistral', 'qwen', 'gpt', 'copilot']
_SEP = r'[\s_\-]*'
_B0, _B1 = r'(?<![A-Za-z0-9])', r'(?![A-Za-z0-9])'
MAX_PER_UNIT = 6   # messages per unit and kind (the rest are counted in one line)

# GC item fields shown on the item screen (gc/gc.js) → label used in messages; line = which source line holds it
GC_FIELDS = [
    (('title',), '채점 항목 제목', 'element'), (('criterion',), '감점 기준', 'element'), (('question_text',), '채점표 질문', 'question'),
    (('rater', 'type'), 'AI 채점 유형', 'row'), (('rater', 'quotes'), 'AI 채점 인용', 'row'), (('rater', 'quotes_raw'), 'AI 채점 인용', 'row'),
    (('rater', 'reason'), 'AI 채점 판정 사유', 'row'), (('audit', 'category'), 'AI 감사 분류', 'row'),
    (('audit', 'explanation'), 'AI 감사 의견', 'row'), (('audit', 'evidence'), 'AI 감사 근거', 'row'), (('basis',), '채점표 적용 근거', 'row'),
]


def _flex(text):
    """Regex for text that ignores case, spaces, hyphens and underscores (the alias matching rule of cases/models.json)."""
    return _SEP.join(re.escape(c) for c in norm_alias(text))


class Matcher:
    """Patterns built from the model registry (+ the GC run ids of the set being built)."""

    def __init__(self, models, runs=None):
        self.pats = []   # (compiled, kind, model code, shown term)
        covered = set()
        for m in models.entries:
            code = m['code']
            terms = {}
            for a in [m.get('name', '')] + list(m.get('aliases') or []):
                k = norm_alias(a)
                if a and k and k != code and k not in terms:
                    terms[k] = a
            for k, a in sorted(terms.items(), key=lambda kv: -len(kv[0])):
                self.pats.append((re.compile(_B0 + _flex(a) + _B1, re.I), 'name', code, a))
            self.pats.append((re.compile(_B0 + re.escape(code) + _B1, re.I), 'code', code, code))
            covered.add(code)
        for w in VENDOR_WORDS:
            if w not in covered:
                self.pats.append((re.compile(_B0 + re.escape(w) + _B1, re.I), 'vendor', '', w))
        # run ids: the whole id, and fragments (letters + digits, 5+ chars) that belong to one model only
        runs = runs or {}
        frags = {}
        for code, ids in runs.items():
            for rid in ids:
                if not rid:
                    continue
                self.pats.append((re.compile(_B0 + re.escape(rid) + _B1, re.I), 'run', code, rid))
                for f in re.split(r'[_\-.\s]+', rid):
                    if len(f) >= 5 and re.search(r'[A-Za-z]', f) and re.search(r'\d', f):
                        frags.setdefault(f.lower(), set()).add(code)
        for f, codes in sorted(frags.items()):
            if len(codes) == 1:     # shared fragments ('profile12') do not tell the models apart
                self.pats.append((re.compile(_B0 + re.escape(f) + _B1, re.I), 'run', next(iter(codes)), f))
        # longest terms first: a run id or a full name claims its text before a code inside it does
        self.pats.sort(key=lambda p: -len(norm_alias(p[3])))

    def hits(self, text):
        """[(kind, code, matched text, term)] for one display string (kind: name | code | compound | vendor | run)."""
        out, spans = [], []
        s = str(text or '')
        if not s:
            return out
        for rx, kind, code, term in self.pats:
            for m in rx.finditer(s):
                if any(m.start() < b and a < m.end() for a, b in spans):
                    continue      # already reported as part of a longer name / run id
                k = kind
                if kind == 'code' and code.lower() not in VENDOR_WORDS:
                    # only a generic code ('alpha', 'beta') can be the first part of an ordinary compound word;
                    # a vendor/model word stays an error even when hyphenated ('DeepSeek-R1', 'GPT-based')
                    after, before = s[m.end():m.end() + 2], s[max(0, m.start() - 2):m.start()]
                    if re.match(r'-[A-Za-z]', after) or re.match(r'[A-Za-z]-', before):
                        k = 'compound'
                spans.append((m.start(), m.end()))
                out.append((k, code, m.group(0), term))
        return out


def _strings(obj, path=()):
    """Every string value in a JSON-like object (dict keys are field names, not shown text)."""
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            for x in _strings(v, path + (str(k),)):
                yield x
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            for x in _strings(v, path + (str(i + 1),)):
                yield x


def _get(d, keys):
    for k in keys:
        d = d.get(k) if isinstance(d, dict) else None
    return d


class _Lines:
    """Source files read once, to point at the line that holds a hit."""

    def __init__(self):
        self.cache = {}

    def find_text(self, loc, text, rx):
        """The line (at/after loc) that holds this string value: its JSON form or plain text, else the first line matching rx."""
        s = str(text)
        for probe in (json.dumps(s, ensure_ascii=False)[1:-1][:48], s[:48]):
            if len(probe) >= 8:
                hit = self.find(loc, re.compile(re.escape(probe)), default='')
                if hit:
                    return hit
        return self.find(loc, rx)

    def find(self, loc, rx, default=None):
        """loc = 'path:line' of the section start; returns 'path:line' of the first line at/after it that matches rx."""
        path, _, n = str(loc).rpartition(':')
        try:
            start = int(n)
        except ValueError:
            return loc
        if path not in self.cache:
            from .common import ROOT
            import pathlib
            p = pathlib.Path(path)
            if not p.is_absolute():
                p = ROOT / p
            try:
                self.cache[path] = p.read_text(encoding='utf-8').replace('**', '').split('\n')
            except OSError:
                self.cache[path] = []
        lines = self.cache[path]
        for i in range(max(0, start - 1), len(lines)):
            if rx.search(lines[i]):
                return '%s:%d' % (path, i + 1)
        return loc if default is None else default


_MSG = {
    'name': ('error', '%s: 평가자 화면에 보이는 글(%s)에 모델 %s 의 이름 "%s" 이(가) 있습니다 [model-name-in-text]',
             '모델이 드러나지 않도록 원문에서 지우거나 일반 표현(예: "이 CDSS")으로 바꾸세요 — 모델 이름·별칭 목록: cases/models.json'),
    'code': ('error', '%s: 평가자 화면에 보이는 글(%s)에 모델 %s 의 code "%s" 이(가) 있습니다 [model-name-in-text]',
             '모델이 드러나지 않도록 원문에서 지우거나 바꾸세요 (code 는 unit 키·응답 시트에만 씁니다)'),
    'run': ('error', '%s: 평가자 화면에 보이는 글(%s)에 모델 %s 의 실행 ID "%s" 이(가) 있습니다 [run-id-in-text]',
            '실행 ID 는 모델 이름을 담고 있어 화면에 보이면 안 됩니다 — 원문에서 지우세요'),
    'compound': ('warn', '%s: 화면에 보이는 글(%s)의 "%s" 가 모델 %s 의 code "%s" 로 시작합니다 [model-code-compound]',
                 '약 이름 등 일반 용어(예: alpha-glucosidase)이면 그대로 두어도 됩니다. 모델을 가리키면 지우세요'),
    'vendor': ('warn', '%s: 화면에 보이는 글(%s)에 AI 회사·제품 이름 "%s" 이(가) 있습니다 [vendor-name-in-text]',
               '평가 대상 모델을 짐작하게 하면 지우세요 (cases/models.json 에 없는 이름이라 오류로 막지는 않습니다)'),
}


def _report(problems, where, label, field, hit, counts):
    kind, code, text, term = hit
    key = (label, kind)
    counts[key] = counts.get(key, 0) + 1
    if counts[key] > MAX_PER_UNIT:
        return
    sev, msg, hint = _MSG[kind]
    if kind == 'compound':
        line = msg % (label, field, text, code, code)
    elif kind == 'vendor':
        line = msg % (label, field, text)
    else:
        line = msg % (label, field, code, text)
    (problems.error if sev == 'error' else problems.warn)(where, line, hint)


def check(models, problems, ca_outputs=None, ca_patients=None, ca_loc=None, gc_units=None):
    """Scan one set's display texts. ca_outputs {key: raw output}, ca_patients {pid: record}, ca_loc {key | 'patient:PID': 'file:line'},
    gc_units [parsed unit with 'items', 'lines', 'where', 'run']. Returns the number of hits reported as errors."""
    runs = {}
    for u in gc_units or []:
        runs.setdefault(u['model'], []).append(u.get('run') or '')
    mt = Matcher(models, runs)
    L = _Lines()
    n_err0 = len(problems.errors)
    counts = {}
    for key, o in (ca_outputs or {}).items():
        loc = (ca_loc or {}).get(key, key)
        shown = {'phase_1': o.get('phase_1'), 'combinations': o.get('combinations')}
        for path, s in _strings(shown):
            for h in mt.hits(s):
                field = 'CA 출력 ' + ' › '.join(path)
                _report(problems, L.find_text(loc, s, re.compile(re.escape(h[2]))), key, field, h, counts)
    for pid, rec in (ca_patients or {}).items():
        loc = (ca_loc or {}).get('patient:' + pid, pid)
        for path, s in _strings(rec):
            for h in mt.hits(s):
                _report(problems, L.find(loc, re.compile(re.escape(h[2]))), 'patient ' + pid, '환자 기록', h, counts)
    for u in gc_units or []:
        for it in u['items']:
            ln = (u.get('lines') or {}).get(it['id'], {})
            base = u['where'].rpartition(':')[0]
            for keys, label, which in GC_FIELDS:
                v = _get(it, keys)
                vals = v if isinstance(v, list) else [v]
                for s in vals:
                    for h in mt.hits(s):
                        where = '%s:%s' % (base, ln.get(which)) if ln.get(which) else u['where']
                        _report(problems, where, it['id'], 'GC ' + label, h, counts)
    for (label, kind), n in sorted(counts.items()):
        if n > MAX_PER_UNIT:
            sev = _MSG[kind][0]
            (problems.error if sev == 'error' else problems.warn)(label, '같은 종류의 블라인딩 문제가 %d건 더 있습니다 [%s]' % (
                n - MAX_PER_UNIT, 'model-name-in-text' if kind in ('name', 'code') else
                {'run': 'run-id-in-text', 'compound': 'model-code-compound', 'vendor': 'vendor-name-in-text'}[kind]))
    return len(problems.errors) - n_err0


__all__ = ['Matcher', 'check', 'VENDOR_WORDS']
