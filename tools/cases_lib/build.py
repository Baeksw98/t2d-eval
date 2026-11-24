"""Build one case set: sources → T2D_DATA (CA), GC_DATA (GC), T2D_DESIGN (Types/Parts) and the backend GC copy."""
import hashlib
import json
import pathlib

from . import blinding, ca_parse, design, gc_parse, validate
from .common import CASES, SET_ID_RE, load_json, rel, window_js


class SetBuild:
    def __init__(self, man):
        self.id = man['id']
        self.man = man
        self.ca_data = None
        self.gc_data = None
        self.gc_backend = None
        self.design = None
        self.notes = []

    def files(self):
        """{repo-relative path: text} of this set's archive files."""
        out = {
            'data/sets/%s/cases.js' % self.id: window_js('T2D_DATA', self.ca_data),
            'data/sets/%s/design.js' % self.id: window_js('T2D_DESIGN', self.design),
        }
        if self.gc_data is not None:
            out['gc/data/sets/%s/gc_items.js' % self.id] = window_js('GC_DATA', self.gc_data)
            out['gc/data/sets/%s.json' % self.id] = backend_json(self.gc_backend)
        return out

    def active_files(self):
        out = self.ca_active_files()
        out.update(self.gc_active_files())
        return out

    def ca_active_files(self):
        """Active files of the CA track (and of the landing / QR pages): data/cases.js, data/design.js."""
        return {
            'data/cases.js': window_js('T2D_DATA', self.ca_data),
            'data/design.js': window_js('T2D_DESIGN', self.design),
        }

    def gc_active_files(self):
        """Active file of the GC track: gc/data/gc_items.js (the GC page loads this set's cases/design from its archive)."""
        return {'gc/data/gc_items.js': window_js('GC_DATA', self.gc_data)} if self.gc_data is not None else {}


# gas/gc/gc.gs gcFetchJson_ caches a set's JSON only below this many characters (CacheService values are capped at 100 KB)
GC_CACHE_MAX_CHARS = 95000


def backend_json(obj):
    """gc/data/sets/<id>.json — compact JSON read by the GC Apps Script (UrlFetchApp) and embedded as GC_ITEMS."""
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n'


def index_json(active, cases_dir=CASES):
    """gc/data/sets/index.json — the active set and every set that has GC data (read by the GC Apps Script summary)."""
    sets = []
    for sid in list_sets(cases_dir):
        try:
            m = json.loads((pathlib.Path(cases_dir) / 'sets' / ('%s.json' % sid)).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if isinstance(m, dict) and m.get('gc', {}) not in (False, None):
            sets.append(sid)
    return json.dumps({'active': active, 'sets': sets}, ensure_ascii=False) + '\n'


def content_version(sid, kind, obj):
    h = hashlib.sha1(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:8]
    return '%s.%s-%s' % (sid, kind, h)


def list_sets(cases_dir=CASES):
    return sorted(p.stem for p in (pathlib.Path(cases_dir) / 'sets').glob('*.json'))


def active_set(problems, cases_dir=CASES):
    path = pathlib.Path(cases_dir) / 'active.json'
    d = load_json(path, problems)
    sid = d.get('set') if isinstance(d, dict) else None
    if d is not None and (not isinstance(sid, str) or not SET_ID_RE.match(sid)):
        problems.error(rel(path), '"set" 에 활성 세트 ID 가 필요합니다 (예: {"set": "v1"}) [bad-active]')
        return None
    if sid and sid not in list_sets(cases_dir):
        problems.error(rel(path), '활성 세트 "%s" 의 매니페스트 cases/sets/%s.json 이 없습니다 [unknown-active]' % (sid, sid))
    return sid


def active_gc_set(problems, ca_active, cases_dir=CASES):
    """The set the GC track uses: cases/active.json "gc_set" (optional; default = "set").
    Lets the CA track move to a CA-only set (e.g. v2, "gc": false) while /gc/ keeps a set that has GC data."""
    path = pathlib.Path(cases_dir) / 'active.json'
    d = load_json(path, problems)
    sid = d.get('gc_set', ca_active) if isinstance(d, dict) else ca_active
    if sid is None:
        return None
    if not isinstance(sid, str) or not SET_ID_RE.match(sid):
        problems.error(rel(path), '"gc_set" 에 GC 트랙의 세트 ID 가 필요합니다 (예: {"set": "v2", "gc_set": "v1"}) [bad-active]')
        return None
    if sid not in list_sets(cases_dir):
        problems.error(rel(path), 'GC 세트 "%s" 의 매니페스트 cases/sets/%s.json 이 없습니다 [unknown-active]' % (sid, sid))
    return sid


def resolve(patterns, base, problems, where, kind):
    files, seen = [], set()
    for pat in patterns:
        hits = sorted(p for p in base.glob(pat) if p.is_file() and p.suffix.lower() in ('.md', '.markdown', '.txt'))
        if not hits:
            problems.error(where, 'sources.%s 의 "%s" 에 해당하는 파일이 cases/sources/ 에 없습니다 [no-source-files]' % (kind, pat))
        for p in hits:
            if p not in seen:
                seen.add(p)
                files.append(p)
    return files


def build_set(sid, models, problems, cases_dir=CASES):
    cases_dir = pathlib.Path(cases_dir)
    path = cases_dir / 'sets' / ('%s.json' % sid)
    raw = load_json(path, problems)
    if raw is None:
        return None
    n_err = len(problems.errors)
    man = validate.manifest(raw, path, models, problems)
    if man is None:
        return None
    b = SetBuild(man)
    where = man['where']
    src_base = cases_dir / 'sources'

    # ---------------- CA ----------------
    ca_files = resolve(man['sources']['ca'], src_base, problems, where, 'ca')
    outputs_raw, patients_raw, loc = ca_parse.parse_sources(ca_files, models, problems)
    for u in man['units']:
        if u not in outputs_raw:
            problems.error(where, '%s (환자 %s × 모델 %s) 의 CDSS 출력이 sources.ca 파일에 없습니다 [missing-output]' % ((u,) + tuple(u.split('_', 1))),
                           'cases/sources/ca/ 에 "%s %s" 제목과 출력 JSON 을 넣으세요 (모델 이름은 cases/models.json 의 별칭)' % (u.split('_', 1)[0], models.name_of(u.split('_', 1)[1])))
    for p in man['patients']:
        if p not in patients_raw:
            problems.error(where, '환자 %s 의 기록("%s Patient Input Information")이 sources.ca 파일에 없습니다 [missing-record]' % (p, p))
    set_patients = {p: patients_raw[p] for p in patients_raw if p in man['patients']}
    patients = ca_parse.build_patients(set_patients, loc, problems)
    outputs = {}
    for key, o in outputs_raw.items():
        if key in man['units']:
            ca_parse.check_output(key, o, loc[key], problems)
            outputs[key] = ca_parse.build_output(key, o, models)
    content = {'patients': patients, 'outputs': outputs}
    dv = man['data_version']['ca'] or content_version(sid, 'ca', content)
    b.ca_data = {'data_version': dv, 'set_id': sid, 'patients': patients, 'outputs': outputs}

    # ---------------- Types ----------------
    k = man['ca']['per_session']
    if man['ca']['types'] in (None, 'auto'):
        try:
            types, notes = design.auto_groups(man['units'], man['patients'], man['models'], k, 'Type')
            b.notes += ['CA: ' + n for n in notes]
        except ValueError as e:
            problems.error(where, 'CA Type 을 만들 수 없습니다: %s [design]' % e)
            types = []
    else:
        types = validate.groups(man['ca']['types'], man['units'], 'Type', where + ' ca.types', problems)
    n_units = len(man['units'])
    if len(types) > 6:
        divisors = [d for d in range(2, n_units + 1) if n_units % d == 0 and d <= 6]
        problems.warn(where, 'CA Type 이 %d개입니다 — 평가자가 고르기 어렵고 Type 마다 응답자가 적어집니다 [many-groups]' % len(types),
                      '세션당 건수(ca.per_session)를 단위 수 %d 의 약수로 고르면 각 답변이 한 번씩만 나옵니다: %s' %
                      (n_units, ', '.join(map(str, divisors)) or '(없음)'))
    lo, hi = man['ca']['minutes_per_unit']
    ca_design = {'per_session': k, 'minutes': [_num(lo * k), _num(hi * k)], 'types': types}

    # ---------------- GC ----------------
    gc_design = None
    if man['gc'] is not None:
        gc_files = resolve(man['sources']['gc'], src_base, problems, where, 'gc')
        units, where_unit = {}, {}
        for f in gc_files:
            for u in gc_parse.parse(f, models, problems):
                if u['key'] not in man['units']:
                    continue
                if u['key'] in units:
                    problems.error(u['where'], '%s 검증 보고서가 두 번 있습니다 (처음: %s) [duplicate-key]' % (u['key'], where_unit[u['key']]),
                                   '세트 매니페스트의 sources.gc 로 쓸 파일을 고르세요')
                    continue
                units[u['key']] = u
                where_unit[u['key']] = u['where']
        for u in man['units']:
            if u not in units:
                problems.error(where, '%s 의 채점·감사 검증 보고서("# E11_%s · <모델> 채점·감사 검증 자료")가 sources.gc 파일에 없습니다 [missing-gc-report]' % (u, u.split('_', 1)[0]),
                               'GC 자료가 아직 없으면 매니페스트에 "gc": false 로 두세요 (이 세트는 CA 만)')
        for key, u in units.items():
            if not u['items']:
                problems.warn(u['where'], '%s: AI 감사가 표시한 판정(△/✗)이 없어 GC Part 에서 빠집니다 [no-flagged-items]' % key)
            if not u['conc']:
                problems.error(u['where'], '%s: 채점 판정 표를 하나도 읽지 못했습니다 [no-judgments]' % key,
                               '"**Q2.1-02 제목** — 감점 기준: …" 아래 "| 조합 1 | …" 표 형식이 기존 보고서와 같은지 확인하세요')
            bad = [it['id'] for it in u['items'] if it['combo'] > ca_parse.N_COMBINATIONS]
            if bad:
                problems.error(u['where'], '%s: 조합 번호가 %d 보다 큰 판정: %s [bad-combo]' % (key, ca_parse.N_COMBINATIONS, ', '.join(bad[:5])))
        ordered = [units[k2] for k2 in units]   # source order
        gc_units = {u['key']: gc_parse.unit_record(u) for u in ordered}
        gdv = man['data_version']['gc'] or content_version(sid, 'gc', gc_units)
        b.gc_data = {'data_version': gdv, 'set_id': sid, 'scope': gc_parse.SCOPE, 'units': gc_units}
        flagged = [u for u in man['units'] if u in units and units[u]['items']]
        kg = man['gc']['per_session']
        parts = []
        if not flagged:
            problems.error(where, 'GC 검증 대상 판정이 있는 unit 이 없습니다 [no-gc-units]')
        elif man['gc']['parts'] in (None, 'auto'):
            try:
                parts, notes = design.auto_groups(flagged, man['patients'], man['models'], min(kg, len(flagged)), 'Part')
                b.notes += ['GC: ' + n for n in notes]
            except ValueError as e:
                problems.error(where, 'GC Part 를 만들 수 없습니다: %s [design]' % e)
        else:
            parts = validate.groups(man['gc']['parts'], flagged, 'Part', where + ' gc.parts', problems)
        mpi = man['gc']['minutes_per_item']
        for p in parts:
            n_items = sum(len(units[u2]['items']) for u2 in p['sequences'][0] if u2 in units)
            p['items'] = n_items
            p['minutes'] = design.gc_minutes(n_items, mpi)
        mins = [p['minutes'] for p in parts]
        gc_design = {'per_session': kg, 'minutes_per_item': mpi,
                     'minutes': [min(m[0] for m in mins), max(m[1] for m in mins)] if mins else None, 'parts': parts}
        b.gc_backend = gc_parse.compact(b.gc_data, parts)
        size = len(backend_json(b.gc_backend))
        if size >= GC_CACHE_MAX_CHARS:
            problems.warn(where, 'GC 백엔드용 gc/data/sets/%s.json 이 %d자입니다 — Apps Script 캐시 한도(%d자) 이상이라 GC 응답마다 사이트에서 '
                                 '다시 읽습니다 (동작은 하지만 느려질 수 있음) [gc-json-large]' % (sid, size, GC_CACHE_MAX_CHARS),
                          '세트를 둘로 나누거나 gas/gc/gc.gs 의 캐시 방식을 바꾸세요 (예: 단위별로 나눠 캐시)')

    # ---------------- blinding: no model name / code / run id in any text the evaluators see ----------------
    blinding.check(models, problems,
                   ca_outputs={k2: o for k2, o in outputs_raw.items() if k2 in man['units']},
                   ca_patients=set_patients, ca_loc=loc,
                   gc_units=list(units.values()) if man['gc'] is not None else [])

    b.design = {
        'set_id': sid,
        'data_version': b.ca_data['data_version'],
        'gc_data_version': b.gc_data['data_version'] if b.gc_data else None,
        'status': man['status'],
        'title': man['title'],
        'units': [{'key': u, 'patient': u.split('_', 1)[0], 'model': u.split('_', 1)[1]} for u in man['units']],
        'ca': ca_design,
        'gc': gc_design,
    }
    if len(problems.errors) > n_err:
        return None
    return b


def _num(x):
    return int(x) if float(x).is_integer() else x


def summary_lines(b):
    d = b.design
    out = ['세트 %s (%s) — %s' % (b.id, d['status'], d['title']['ko']),
           '  단위 %d개 = 환자 %s × 모델 %s' % (len(d['units']), ', '.join(b.man['patients']), ', '.join(b.man['models'])),
           '  CA data_version %s · 세션당 %d건 · 약 %s–%s분' % (d['data_version'], d['ca']['per_session'], d['ca']['minutes'][0], d['ca']['minutes'][1])]
    for t in d['ca']['types']:
        out.append('    Type %-3s %s' % (t['id'], '  |  '.join(' → '.join(s) for s in t['sequences'])))
    if d['gc']:
        g = d['gc']
        out.append('  GC data_version %s · 세션당 %d건 · 판정당 %s분' % (d['gc_data_version'], g['per_session'], g['minutes_per_item']))
        for p in g['parts']:
            out.append('    Part %-3s 판정 %2d건 · 약 %d–%d분 · %s' % (p['id'], p['items'], p['minutes'][0], p['minutes'][1],
                                                         '  |  '.join(' → '.join(s) for s in p['sequences'])))
    else:
        out.append('  GC: 없음 ("gc": false)')
    for n in b.notes:
        out.append('  ※ ' + n)
    return out
