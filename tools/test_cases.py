#!/usr/bin/env python3
"""Tests for the modular case pipeline (tools/cases_lib, tools/build_cases.py).

    python3 tools/test_cases.py

1) Set v1 is reproduced exactly: the data built from cases/ equals the live study's data (content hashes of the
   pre-pipeline data/cases.js and gc/data/gc_items.js, i.e. commit 9e8509f, apart from the added set_id), the legacy
   intermediate data/parsed_raw.json, and the committed outputs; 'auto' Types/Parts on v1 equal today's frozen
   Types/Parts (and the literals in config.js / gc/gc-config.js); the committed outputs are up to date (--check).
2) A synthetic 3 patients × 3 models set (tools/fixtures/cases/) builds valid blocks: balance, distinct patients and
   models per block, counterbalanced orders, GC Parts with item counts and minutes; other block sizes too.
3) Validation catches a missing output, an unknown model, duplicate keys and other broken inputs, and writes nothing;
   a GC report that deviates in one place (element header, row, verdict, audit, phase) is an error with file:line;
   a model name / alias / code / run id in any text evaluators see is an error (blinding); a frozen set's archive never
   changes silently. The active-set checks follow cases/active.json, so they also pass after a set switch.
Prints PASS/FAIL lines; exit 1 on failure. No network.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.dont_write_bytecode = True   # no __pycache__ in the repository
sys.path.insert(0, str(HERE))
from cases_lib import build, common, design, gc_parse  # noqa: E402

ROOT = common.ROOT
FIX = HERE / 'fixtures' / 'cases'
SCRATCH = pathlib.Path(tempfile.mkdtemp(prefix='t2d-cases-test-'))
passed, failed = 0, 0

# content hashes (canonical JSON, sorted keys) of the live study's data before the pipeline existed (commit 9e8509f)
FROZEN_V1 = {
    'T2D_DATA': '8c3e9e5c7e082ede9237add20ab23469edba833ad6457b21b5745df58adb6110',
    'GC_DATA': '14d1ae7a1b9120891e5d7f4213e8cf3e1a35ea3a9342032867efb68049d1f2a6',
}
V1_TYPES = [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']], [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']]


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('PASS ' + name)
    else:
        failed += 1
        print('FAIL ' + name + (('  — ' + str(detail)) if detail else ''))


def eq(name, got, want):
    ok(name, got == want, 'got %r, want %r' % (got, want))


def canon_hash(obj):
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def without(d, *keys):
    return {k: v for k, v in d.items() if k not in keys}


def build_in(cases_dir, sid):
    P = common.Problems()
    models = common.load_models(P, pathlib.Path(cases_dir) / 'models.json')
    b = build.build_set(sid, models, P, cases_dir) if P.ok() else None
    return b, P


def node_json(js_expr, files):
    """Evaluate config files in node (window = {}) and return JSON, or None when node is unavailable."""
    code = ("const vm=require('vm'),fs=require('fs');const w={};" +
            ''.join("vm.runInNewContext(fs.readFileSync(%s,'utf8'),{window:w});" % json.dumps(str(ROOT / f)) for f in files) +
            'process.stdout.write(JSON.stringify(%s));' % js_expr)
    try:
        return json.loads(subprocess.check_output(['node', '-e', code]).decode('utf-8'))
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


# =====================================================================
# 1) Set v1
# =====================================================================
b, P = build_in(common.CASES, 'v1')
ok('v1 builds without errors', b is not None and P.ok(), P.report())
# (a model added to cases/models.json later whose code starts an ordinary term in v1's text, e.g. 'beta' in 'beta-blocker', only adds
#  [model-code-compound] advisories — v1's text is frozen, so those are not parse regressions)
ok('v1 builds without warnings', not [w for w in P.warnings if '[model-code-compound]' not in w], P.warnings)
if b:
    eq('v1 set_id in T2D_DATA', b.ca_data['set_id'], 'v1')
    eq('v1 set_id in GC_DATA', b.gc_data['set_id'], 'v1')
    eq('v1 CA data_version frozen', b.ca_data['data_version'], '2026-11-18.v1')
    eq('v1 GC data_version frozen', b.gc_data['data_version'], '2026-11-19.gc2')
    eq('v1 T2D_DATA content = live study (hash of 9e8509f data/cases.js, without set_id)', canon_hash(without(b.ca_data, 'set_id')), FROZEN_V1['T2D_DATA'])
    eq('v1 GC_DATA content = live study (hash of 9e8509f gc/data/gc_items.js, without set_id)', canon_hash(without(b.gc_data, 'set_id')), FROZEN_V1['GC_DATA'])
    eq('v1 T2D_DATA key order', list(b.ca_data), ['data_version', 'set_id', 'patients', 'outputs'])
    eq('v1 patients order (document order)', list(b.ca_data['patients']), ['P011', 'P051'])
    eq('v1 outputs order (document order)', list(b.ca_data['outputs']), ['P051_deepseek', 'P011_deepseek', 'P011_gpt', 'P051_gpt'])
    eq('v1 GC units order (report order)', list(b.gc_data['units']), ['P051_gpt', 'P051_deepseek', 'P011_gpt', 'P011_deepseek'])
    # legacy intermediate: the parsed CA source equals data/parsed_raw.json
    from cases_lib import ca_parse
    P2 = common.Problems()
    outs, pats, _ = ca_parse.parse_sources([common.CASES / 'sources' / 'ca' / '2026-11-18_CDSS_P051_P011.md'], common.load_models(P2), P2)
    raw_path = ROOT / 'data' / 'parsed_raw.json'   # legacy local intermediate (git-ignored), compared only when present
    if raw_path.exists():
        raw = json.loads(raw_path.read_text(encoding='utf-8'))
        ok('v1 CA source parses to data/parsed_raw.json (legacy intermediate)', outs == raw['outputs'] and pats == raw['patients_raw'])
    else:
        print('SKIP data/parsed_raw.json not present (git-ignored legacy intermediate)')
    # direct comparison with the pre-pipeline files when git history is available
    try:
        old_ca = subprocess.check_output(['git', '-C', str(ROOT), 'show', '9e8509f:data/cases.js'], stderr=subprocess.DEVNULL).decode('utf-8')
        old_gc = subprocess.check_output(['git', '-C', str(ROOT), 'show', '9e8509f:gc/data/gc_items.js'], stderr=subprocess.DEVNULL).decode('utf-8')
        body = lambda s, v: json.loads(s[s.index('window.%s = ' % v) + len('window.%s = ' % v):].strip().rstrip(';'))
        eq('v1 T2D_DATA = 9e8509f data/cases.js (structural, set_id aside)', without(b.ca_data, 'set_id'), body(old_ca, 'T2D_DATA'))
        eq('v1 GC_DATA = 9e8509f gc/data/gc_items.js (structural, set_id aside)', without(b.gc_data, 'set_id'), body(old_gc, 'GC_DATA'))
        new_text = common.window_js('T2D_DATA', b.ca_data)
        diff = [l for l in set(new_text.split('\n')) ^ set(old_ca.split('\n'))]
        ok('v1 data/cases.js text differs from 9e8509f only in the header line and the set_id line',
           sorted(diff) == sorted([' "set_id": "v1",', '/* AUTO-GENERATED by tools/build_cases.py — do not edit by hand. */',
                                   '/* AUTO-GENERATED by tools/build_data.py — do not edit by hand. */']), diff[:6])
    except (OSError, subprocess.CalledProcessError):
        print('SKIP git history not available (shallow clone): direct comparison with 9e8509f')
    # Types / Parts
    eq('v1 Type A (frozen)', b.design['ca']['types'][0]['sequences'], V1_TYPES[0])
    eq('v1 Type B (frozen)', b.design['ca']['types'][1]['sequences'], V1_TYPES[1])
    eq('v1 Part A = Type A', b.design['gc']['parts'][0]['sequences'], V1_TYPES[0])
    eq('v1 Part B = Type B', b.design['gc']['parts'][1]['sequences'], V1_TYPES[1])
    eq('v1 Part items 18 / 11', [p['items'] for p in b.design['gc']['parts']], [18, 11])
    eq('v1 Part minutes 20–25 / 10–15 (1.2 min per item)', [p['minutes'] for p in b.design['gc']['parts']], [[20, 25], [10, 15]])
    eq('v1 CA minutes 20–30', b.design['ca']['minutes'], [20, 30])
    eq('v1 GC minutes 10–25 (landing card default)', b.design['gc']['minutes'], [10, 25])
    auto_t, notes = design.auto_groups(b.design and [u['key'] for u in b.design['units']], b.man['patients'], b.man['models'], 2, 'Type')
    eq("'auto' on v1 = frozen Types (ids, labels, sequences)", auto_t, b.design['ca']['types'])
    flagged = [k for k in b.man['units'] if b.gc_data['units'][k]['items']]
    auto_p, _ = design.auto_groups(flagged, b.man['patients'], b.man['models'], 2, 'Part')
    eq("'auto' on v1 = frozen Parts", [p['sequences'] for p in auto_p], [p['sequences'] for p in b.design['gc']['parts']])
    eq("'auto' on v1: no relaxation notes", notes, [])
    cfg = node_json('{t: w.T2D_CONFIG.STUDY_TYPES, p: w.GC_CONFIG.PARTS}', ['config.js', 'gc/gc-config.js'])
    if cfg is None:
        print('SKIP node not available: config.js / gc-config.js literal comparison')
    else:
        eq('v1 Types = config.js STUDY_TYPES (fallback literals)', [t['sequences'] for t in b.design['ca']['types']], [t['sequences'] for t in cfg['t']])
        eq('v1 Parts = gc/gc-config.js PARTS (fallback literals)', [p['sequences'] for p in b.design['gc']['parts']], [p['sequences'] for p in cfg['p']])
    # backend copy
    comp = b.gc_backend
    eq('v1 backend copy: set_id / data_version', (comp['set_id'], comp['data_version']), ('v1', '2026-11-19.gc2'))
    eq('v1 backend copy: Parts', [(p['id'], p['sequences'], p['items'], p['minutes']) for p in comp['parts']],
       [('A', V1_TYPES[0], 18, [20, 25]), ('B', V1_TYPES[1], 11, [10, 15])])
    ok('v1 backend copy: compact items (no criterion / explanation texts)', '"criterion"' not in build.backend_json(comp) and '"explanation"' not in build.backend_json(comp))
    ok('v1 backend copy fits one CacheService value (< 100 KB)', len(build.backend_json(comp).encode('utf-8')) < 100 * 1024, len(build.backend_json(comp)))
    # committed v1 archive = what the pipeline writes for v1 (whichever set is active)
    for relp, text in b.files().items():
        fp = ROOT / relp
        ok('committed %s is up to date' % relp, fp.exists() and fp.read_text(encoding='utf-8') == text)

# =====================================================================
# 1b) The active set (cases/active.json): active files = its build = its archive; index.json lists every set with GC data
#     (set-aware: these pass for v1 and after a switch to any other set)
# =====================================================================
PA = common.Problems()
ACTIVE = build.active_set(PA)
ok('cases/active.json names a set (%s)' % ACTIVE, bool(ACTIVE) and PA.ok(), PA.report())
GC_ACTIVE = build.active_gc_set(PA, ACTIVE)          # GC track's set ("gc_set", default = "set")
if ACTIVE:
    ba = b if ACTIVE == 'v1' else build_in(common.CASES, ACTIVE)[0]
    bg = b if GC_ACTIVE == 'v1' else (ba if GC_ACTIVE == ACTIVE else build_in(common.CASES, GC_ACTIVE)[0])
    ok('active set %s builds (GC track: %s)' % (ACTIVE, GC_ACTIVE), ba is not None and bg is not None)
    ok('GC track set %s has GC data' % GC_ACTIVE, bg is not None and bg.gc_data is not None)
    if ba and bg:
        act = dict(ba.ca_active_files()); act.update(bg.gc_active_files())
        for relp, text in act.items():
            fp = ROOT / relp
            ok('committed %s is up to date (CA %s · GC %s)' % (relp, ACTIVE, GC_ACTIVE), fp.exists() and fp.read_text(encoding='utf-8') == text)
        for relp, sid in (('data/cases.js', ACTIVE), ('data/design.js', ACTIVE), ('gc/data/gc_items.js', GC_ACTIVE)):
            arch = relp.replace('data/', 'data/sets/%s/' % sid, 1) if relp.startswith('data/') else 'gc/data/sets/%s/gc_items.js' % sid
            ok('active %s = archive %s' % (relp, arch), (ROOT / relp).read_text(encoding='utf-8') == (ROOT / arch).read_text(encoding='utf-8'))
        gp = (ROOT / 'gc/index.html').read_text(encoding='utf-8')
        ok('the GC page loads the GC set %s from its archive' % GC_ACTIVE,
           ('../data/sets/%s/cases.js' % GC_ACTIVE) in gp and ('../data/sets/%s/design.js' % GC_ACTIVE) in gp and ('data/sets/%s/gc_items.js' % GC_ACTIVE) in gp)
    eq('gc/data/sets/index.json = {active: GC track set, sets: every manifest with GC data}',
       json.loads((ROOT / 'gc/data/sets/index.json').read_text(encoding='utf-8')), json.loads(build.index_json(GC_ACTIVE)))
    ok('index.json lists v1 (archives are never removed)', 'v1' in json.loads((ROOT / 'gc/data/sets/index.json').read_text(encoding='utf-8'))['sets'])
    emb = node_json('w.GC_DATA.set_id', ['gc/data/gc_items.js'])
    if emb is not None:
        eq('gc/data/gc_items.js loads in JS with set_id %s (GC track)' % GC_ACTIVE, emb, GC_ACTIVE)
    for sid in build.list_sets():
        if sid != 'v1':
            ok('archive of set %s exists (data/sets/%s/cases.js)' % (sid, sid), (ROOT / 'data/sets' / sid / 'cases.js').exists())

r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--check'], capture_output=True, text=True)
ok('build_cases.py --check on the repo: exit 0', r.returncode == 0, r.stdout[-800:] + r.stderr[-800:])
ok('build_cases.py --check on the repo: no file would change', '바뀔 파일 0개' in r.stdout, r.stdout[-600:])

# =====================================================================
# 2) Synthetic 3 patients × 3 models
# =====================================================================
def check_groups(label, groups, units, k, r):
    P_, M_ = lambda u: u.split('_')[0], lambda u: u.split('_')[1]
    firsts = [g['sequences'][0] for g in groups]
    cnt = {}
    for f in firsts:
        for u in f:
            cnt[u] = cnt.get(u, 0) + 1
    eq(label + ': every unit appears %d time(s)' % r, sorted(set(cnt.values())), [r])
    eq(label + ': all units covered', sorted(cnt), sorted(units))
    eq(label + ': %d per block' % k, sorted(set(len(f) for f in firsts)), [k])
    n_p = len(set(P_(u) for u in units))
    n_m = len(set(M_(u) for u in units))
    ok(label + ': distinct patients per block where possible', all(max(f.count(x) for x in [P_(u) for u in f] for _ in [0]) <= -(-k // n_p)
                                                                     for f in [[P_(u) for u in ff] for ff in firsts]))
    ok(label + ': distinct models per block where possible', all(max(f.count(x) for x in f) <= -(-k // n_m)
                                                                   for f in [[M_(u) for u in ff] for ff in firsts]))
    ok(label + ': no unit twice in a block', all(len(set(f)) == len(f) for f in firsts))
    for g in groups:
        seqs = g['sequences']
        ok(label + ' %s: every sequence is an order of the same units' % g['id'], all(sorted(s) == sorted(seqs[0]) for s in seqs))
        pos = {}
        for s in seqs:
            for i, u in enumerate(s):
                pos[(u, i)] = pos.get((u, i), 0) + 1
        ok(label + ' %s: each unit in each position equally often (%d orders)' % (g['id'], len(seqs)), len(set(pos.values())) == 1 and len(pos) == k * k)
        if k > 1:
            follow = {}
            for s in seqs:
                for a, c in zip(s, s[1:]):
                    follow[(a, c)] = follow.get((a, c), 0) + 1
            ok(label + ' %s: every unit follows every other equally often (carry-over balance)' % g['id'],
               len(follow) == k * (k - 1) and len(set(follow.values())) == 1, follow)


b3, P3 = build_in(FIX, 'syn3')
ok('3×3 fixture builds without errors', b3 is not None and P3.ok(), P3.report())
if b3:
    units = [u['key'] for u in b3.design['units']]
    eq('3×3: 9 units', len(units), 9)
    eq('3×3: 3 Types (per_session 3)', [t['id'] for t in b3.design['ca']['types']], ['A', 'B', 'C'])
    check_groups('3×3 CA k=3', b3.design['ca']['types'], units, 3, 1)
    eq('3×3: 6 counterbalanced orders per Type (Williams, odd k)', sorted(set(len(t['sequences']) for t in b3.design['ca']['types'])), [6])
    eq('3×3: CA minutes 30–45', b3.design['ca']['minutes'], [30, 45])
    eq('3×3: model names from models.json', sorted(set(o['model_name'] for o in b3.ca_data['outputs'].values())), ['Alpha One', 'Beta Two', 'Gamma Three'])
    eq('3×3: header styles "P101 Alpha One", "Beta-2 P101", "**P101** **Gamma 3**" all recognised', sorted(b3.ca_data['outputs']), sorted(units))
    eq('3×3: record placed after the outputs is read', sorted(b3.ca_data['patients']), ['P101', 'P102', 'P103'])
    eq('3×3: GC units', sorted(b3.gc_data['units']), sorted(units))
    check_groups('3×3 GC k=3', b3.design['gc']['parts'], units, 3, 1)
    for p in b3.design['gc']['parts']:
        n_items = sum(len(b3.gc_data['units'][u]['items']) for u in p['sequences'][0])
        eq('3×3 Part %s items = sum of its units\' flagged judgments' % p['id'], p['items'], n_items)
        eq('3×3 Part %s minutes from 1.2 min per item' % p['id'], p['minutes'], design.gc_minutes(n_items, 1.2))
    ok('3×3: data_version derived from content when not given', b3.ca_data['data_version'].startswith('syn3.ca-') and b3.gc_data['data_version'].startswith('syn3.gc-'))
    b3b, _ = build_in(FIX, 'syn3')
    eq('3×3: deterministic (second build identical)', json.dumps(b3b.files(), sort_keys=True), json.dumps(b3.files(), sort_keys=True))
    # other block sizes over the same 9 units
    pats, mods = b3.man['patients'], b3.man['models']
    for k, r in ((1, 1), (2, 2), (4, 4), (9, 1)):
        g, notes = design.auto_groups(units, pats, mods, k, 'Type')
        check_groups('3×3 k=%d' % k, g, units, k, r)
    # a unit subset (GC units with flagged judgments) and a 2 × 3 grid
    sub = [u for u in units if u != 'P102_beta']
    g, _ = design.auto_groups(sub, pats, mods, 2, 'Part')
    check_groups('8-unit subset k=2', g, sub, 2, 1)
    grid = [p + '_' + m for p in ['P1', 'P2'] for m in ['x', 'y', 'z']]
    g, _ = design.auto_groups(grid, ['P1', 'P2'], ['x', 'y', 'z'], 2, 'Type')
    check_groups('2×3 k=2', g, grid, 2, 1)
    g, notes = design.auto_groups(grid, ['P1', 'P2'], ['x', 'y', 'z'], 3, 'Type')
    check_groups('2×3 k=3 (a patient must repeat)', g, grid, 3, 1)
    eq('williams(2) = base + reversed', design.williams(2), [[0, 1], [1, 0]])
    eq('williams(4) rows', design.williams(4)[0], [0, 1, 3, 2])
    eq('gc_minutes: 18 items → 20–25, 11 → 10–15, 3 → 5–10', [design.gc_minutes(18, 1.2), design.gc_minutes(11, 1.2), design.gc_minutes(3, 1.2)],
       [[20, 25], [10, 15], [5, 10]])
    # CLI writes all outputs for the fixture into a scratch root
    out = SCRATCH / 'out'
    r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(FIX), '--out', str(out), '--quiet'], capture_output=True, text=True)
    ok('CLI on the fixture: exit 0', r.returncode == 0, r.stdout[-600:])
    want = ['data/cases.js', 'data/design.js', 'data/sets/syn3/cases.js', 'data/sets/syn3/design.js', 'gc/data/gc_items.js',
            'gc/data/sets/index.json', 'gc/data/sets/syn3.json', 'gc/data/sets/syn3/gc_items.js']
    eq('CLI on the fixture: contract-4 files', sorted(str(p.relative_to(out)) for p in out.rglob('*') if p.is_file()), want)
    d = json.loads((out / 'gc/data/sets/syn3.json').read_text(encoding='utf-8'))
    eq('fixture backend JSON shape', sorted(d), ['data_version', 'parts', 'scope', 'set_id', 'units'])
    ok('fixture design.js is valid JS data', common.read_window_js(out / 'data/design.js', 'T2D_DESIGN')['set_id'] == 'syn3')
    eq('fixture gc/data/sets/index.json', json.loads((out / 'gc/data/sets/index.json').read_text(encoding='utf-8')), {'active': 'syn3', 'sets': ['syn3']})


# =====================================================================
# 3) Validation
# =====================================================================
def variant(name, mutate):
    d = SCRATCH / name
    shutil.copytree(FIX, d)
    mutate(d)
    return d


def codes(P):
    return ' '.join(P.errors)


def dup_line(path, prefix):
    """Duplicate the first line that starts with prefix (e.g. a judgment row typed twice)."""
    ls = path.read_text(encoding='utf-8').split('\n')
    i = next(k for k, l in enumerate(ls) if l.startswith(prefix))
    path.write_text('\n'.join(ls[:i + 1] + [ls[i]] + ls[i + 1:]), encoding='utf-8')


def edit(path, old, new):
    t = path.read_text(encoding='utf-8')
    assert old in t, (path, old)
    path.write_text(t.replace(old, new, 1), encoding='utf-8')


# missing output: remove the 'Beta-2 P102' section (it ends where the next header starts)
def m_missing(d):
    p = d / 'sources/ca/P102.md'
    t = p.read_text(encoding='utf-8')
    i, j = t.index('Beta-2 P102'), t.index('**P102** **Gamma 3**')
    p.write_text(t[:i] + t[j:], encoding='utf-8')


bm, Pm = build_in(variant('missing', m_missing), 'syn3')
ok('missing output → error, nothing built', bm is None and '[missing-output]' in codes(Pm) and 'P102_beta' in codes(Pm), Pm.report())

bu, Pu = build_in(variant('unknown', lambda d: edit(d / 'sources/ca/P102.md', 'Beta-2 P102', 'Delta-4 P102')), 'syn3')
ok('unknown model in an output header → [unknown-model] with file:line and the alias hint',
   bu is None and '[unknown-model]' in codes(Pu) and 'Delta-4' in codes(Pu) and 'P102.md:' in codes(Pu), Pu.report())
ok('unknown model also reports the unit as missing', '[missing-output]' in codes(Pu))

bd, Pd = build_in(variant('dup', lambda d: shutil.copy(d / 'sources/ca/P101.md', d / 'sources/ca/P101_copy.md')), 'syn3')
ok('duplicate key (same patient × model twice) → [duplicate-key]', bd is None and '[duplicate-key]' in codes(Pd) and 'P101_alpha' in codes(Pd), Pd.report())

bg, Pg = build_in(variant('dupgc', lambda d: shutil.copy(d / 'sources/gc/E11_P101_alpha.md', d / 'sources/gc/E11_P101_alpha_again.md')), 'syn3')
ok('duplicate GC report → [duplicate-key]', bg is None and '[duplicate-key]' in codes(Pg), Pg.report())

bmm, Pmm = build_in(variant('manmodel', lambda d: edit(d / 'sets/syn3.json', '"gamma"', '"zeta"')), 'syn3')
ok('unknown model code in the manifest → [unknown-model]', bmm is None and '[unknown-model]' in codes(Pmm) and 'zeta' in codes(Pmm), Pmm.report())

bgc, Pgc = build_in(variant('nogc', lambda d: (d / 'sources/gc/E11_P103_gamma.md').unlink()), 'syn3')
ok('missing GC report → [missing-gc-report] with the "gc": false hint', bgc is None and '[missing-gc-report]' in codes(Pgc) and '"gc": false' in codes(Pgc), Pgc.report())

def m_gcoff(d):
    m = json.loads((d / 'sets/syn3.json').read_text(encoding='utf-8'))
    m['gc'] = False
    (d / 'sets/syn3.json').write_text(json.dumps(m), encoding='utf-8')
    shutil.rmtree(d / 'sources/gc')
bo, Po = build_in(variant('gcoff', m_gcoff), 'syn3')
ok('"gc": false → CA-only set builds', bo is not None and bo.gc_data is None and bo.design['gc'] is None, Po.report())

bj, Pj = build_in(variant('badjson', lambda d: edit(d / 'sources/ca/P101.md', '"phase_1": {', '"phase_1": {,')), 'syn3')
ok('broken output JSON → [bad-output-json] with line number', bj is None and '[bad-output-json]' in codes(Pj) and 'P101.md:' in codes(Pj), Pj.report())

def m_combos(d):
    p = d / 'sources/ca/P103.md'
    t = p.read_text(encoding='utf-8')
    i = t.index('# P103 Alpha One')
    j = t.index('Beta-2 P103')
    o = json.loads(t[i + len('# P103 Alpha One'):j])
    o['combinations'] = o['combinations'][:2]
    p.write_text(t[:i] + '# P103 Alpha One\n' + json.dumps(o, ensure_ascii=False) + '\n\n' + t[j:], encoding='utf-8')
bc, Pc = build_in(variant('combos', m_combos), 'syn3')
ok('two candidate regimens instead of three → [combination-count]', bc is None and '[combination-count]' in codes(Pc), Pc.report())

ba, Pa = build_in(variant('alias', lambda d: edit(d / 'models.json', '"Gamma 3"', '"Beta-2"')), 'syn3')
ok('alias shared by two models → [duplicate-alias]', ba is None and '[duplicate-alias]' in codes(Pa), Pa.report())

bt, Pt = build_in(variant('types', lambda d: edit(d / 'sets/syn3.json', '"types": "auto"', '"types": [{"id": "A", "sequences": [["P101_alpha", "P999_alpha"]]}]')), 'syn3')
ok('explicit Type with a unit outside the set → [unknown-unit]', bt is None and '[unknown-unit]' in codes(Pt), Pt.report())

def m_persession(d):
    m = json.loads((d / 'sets/syn3.json').read_text(encoding='utf-8'))
    m['ca']['per_session'] = 12
    (d / 'sets/syn3.json').write_text(json.dumps(m), encoding='utf-8')
bk, Pk = build_in(variant('persession', m_persession), 'syn3')
ok('per_session larger than the number of units → [per-session]', bk is None and '[per-session]' in codes(Pk), Pk.report())

br, Pr = build_in(variant('record', lambda d: edit(d / 'sources/ca/P101.md', '### 약물 정보', '### 약 정보')), 'syn3')
ok('patient record without a required section → [bad-record]', br is None and '[bad-record]' in codes(Pr) and '약물 정보' in codes(Pr), Pr.report())

# nothing is written when a set has an error
bad = variant('cli-bad', m_missing)
outb = SCRATCH / 'out-bad'
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(bad), '--out', str(outb)], capture_output=True, text=True)
ok('CLI with an error: exit 1 and no files written', r.returncode == 1 and not outb.exists(), r.stdout[-400:])
ok('CLI with an error: readable message', '[missing-output]' in r.stdout and '아무 파일도 쓰지 않았습니다' in r.stdout)
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(FIX), '--set', 'nope', '--check'], capture_output=True, text=True)
ok('CLI --set with an unknown set → exit 1, lists the sets', r.returncode == 1 and '[unknown-set]' in r.stdout and 'syn3' in r.stdout, r.stdout[-300:])

# GC parser: unknown model in a report title
bad_gc = variant('gcmodel', lambda d: edit(d / 'sources/gc/E11_P101_beta.md', 'Beta Two (0917)', 'Omega (0101)'))
Pq = common.Problems()
units_q = gc_parse.parse(bad_gc / 'sources/gc/E11_P101_beta.md', common.load_models(Pq, bad_gc / 'models.json'), Pq)
ok('GC report with an unknown model → [unknown-model]', not units_q and '[unknown-model]' in codes(Pq) and 'Omega' in codes(Pq), Pq.report())

# GC parser: a report that deviates in ONE place is reported (file:line), never silently mis-read
GCF = 'sources/gc/E11_P102_beta.md'
Q21_HEAD = '**Q2.1-01 효과 과대 기술** — 감점 기준:'
Q21_C1 = '| 조합 1 | −1 감점 | 다루지 않음 | “조합 1 답 2.1” | 규칙 3에 따라 판단. | ✗ → 충족 [충족 여부]'
gc_cases = [
    ('element header with a hyphen instead of the em dash', lambda d: edit(d / GCF, Q21_HEAD, '**Q2.1-01 효과 과대 기술** - 감점 기준:'), '[bad-element]'),
    ('element header without bold', lambda d: edit(d / GCF, Q21_HEAD, 'Q2.1-01 효과 과대 기술 — 감점 기준:'), '[table-without-element]'),
    ('verdict "감점" without −1', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('−1 감점', '감점')), '[bad-verdict]'),
    ('audit "✗ 충족" without the arrow', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('✗ → 충족', '✗ 충족')), '[bad-audit]'),
    ('audit with an unknown mark', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('✗ → 충족', '? 충족')), '[bad-audit]'),
    ('row with a "|" inside a cell (9 cells)', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('규칙 3에 따라', '규칙 3 | 따라')), '[bad-row]'),
    ('row label "조합1" (no space)', lambda d: edit(d / GCF, '| 조합 2 | ○ 충족 |  | “조합 2 답 2.1”', '| 조합2 | ○ 충족 |  | “조합 2 답 2.1”'), '[bad-row]'),
    ('Phase 1 row under a Phase 2 element', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('| 조합 1 |', '| Phase 1 |')), '[phase-mismatch]'),
    ('table split by a blank line', lambda d: edit(d / GCF, '\n| 조합 2 | ○ 충족 |  | “조합 2 답 2.1”', '\n\n| 조합 2 | ○ 충족 |  | “조합 2 답 2.1”'), '[bad-table]'),
    ('row "조합 1" twice in one table (same item id)', lambda d: dup_line(d / GCF, Q21_C1), '[dup-row]'),
    ('row "조합 4" (only 3 candidate regimens)', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('| 조합 1 |', '| 조합 4 |')), '[bad-combo]'),
    ('question header "### 2.1" missing', lambda d: edit(d / GCF, '### 2.1 약물 계열별 추천 요약이 타당합니까?\n', ''), '[no-question]'),
    ('question header number differs from the element', lambda d: edit(d / GCF, '### 2.1 약물', '### 2.2 약물'), '[no-question]'),
    ('flagged audit without an error type "[…]"', lambda d: edit(d / GCF, '✗ → 충족 [충족 여부] reason', '✗ → 충족 reason'), '[no-category]'),
]
for i_case, (label, mut, code) in enumerate(gc_cases):
    d = variant('gcfmt-%d-%s' % (i_case, code.strip('[]')), mut)
    bb, PP = build_in(d, 'syn3')
    ok('GC report: %s → %s with file:line, nothing built' % (label, code), bb is None and code in codes(PP) and 'E11_P102_beta.md:' in codes(PP), PP.report())
# accepted spellings: ASCII '-1' and '->' parse exactly like '−1' and '→'
d_ascii = variant('gcfmt-ascii', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('−1 감점', '-1 감점').replace('✗ → 충족', '✗ -> 충족')))
ba_, Pa_ = build_in(d_ascii, 'syn3')
ok("GC report: ASCII '-1' and '->' accepted", ba_ is not None and Pa_.ok(), Pa_.report())
if ba_ and b3:
    eq("GC report: ASCII spellings give the same items and concordance", ba_.gc_data['units']['P102_beta'], b3.gc_data['units']['P102_beta'])
# fixture-wide: the strict parser reads every element row of the fixture (one row per combination per element)
Pz = common.Problems()
uz = gc_parse.parse(FIX / GCF, common.load_models(Pz, FIX / 'models.json'), Pz)
ok('GC fixture report parses with no problems', Pz.ok() and not Pz.warnings and len(uz) == 1, Pz.report())
# a file without a recognised report title is named (it used to show up only as a missing report of the set)
d_nt = variant('gcfmt-title', lambda d: edit(d / GCF, '# E11_P102 · Beta Two (0917)', '# E11_P102 - Beta Two (0917)'))
bnt, Pnt = build_in(d_nt, 'syn3')
ok('GC report title not recognised → [no-report-title] warning naming the file (+ [missing-gc-report])',
   bnt is None and '[no-report-title]' in Pnt.report() and 'E11_P102_beta.md' in Pnt.report() and '[missing-gc-report]' in codes(Pnt), Pnt.report())

# CA output wrapped in a ```json fence (common in markdown exports) parses as before
def m_fence(d):
    p = d / 'sources/ca/P101.md'
    t = p.read_text(encoding='utf-8')
    i = t.index('# P101 Alpha One')
    j = t.index('\n', i)
    k = t.index('Beta-2 P101')
    p.write_text(t[:j + 1] + '```json\n' + t[j + 1:k].rstrip() + '\n```\n\n' + t[k:], encoding='utf-8')
bf, Pf = build_in(variant('fence', m_fence), 'syn3')
ok('CA output inside a ```json fence parses', bf is not None and Pf.ok(), Pf.report())
if bf and b3:
    eq('CA output inside a fence = same output', bf.ca_data['outputs']['P101_alpha'], b3.ca_data['outputs']['P101_alpha'])

# blinding: a model's name, alias, code or run id in any text the evaluators see → error with file:line
blind_cases = [
    ('alias in a CA Phase 1 answer', lambda d: edit(d / 'sources/ca/P101.md', '"1.2": "P101 답안가 환자 평가"', '"1.2": "P101 답안가 환자 평가 (Alpha One (2026))"'),
     '[model-name-in-text]', 'P101.md:'),
    ('name spelled differently in a combination name', lambda d: edit(d / 'sources/ca/P102.md', '"name": "P102 답안나 조합 2"', '"name": "P102 답안나 조합 2 (beta-two)"'),
     '[model-name-in-text]', 'P102.md:'),
    ('model code in a CA answer', lambda d: edit(d / 'sources/ca/P103.md', '"3.1": "P103 답안다 조합 1 답 3.1"', '"3.1": "P103 답안다 조합 1 답 3.1 (gamma)"'),
     '[model-name-in-text]', 'P103.md:'),
    ('name in a flagged GC audit explanation', lambda d: edit(d / GCF, '[근거 보완] 근거가 부족하다. | 적용 근거 C2', '[근거 보완] Beta Two 의 근거가 부족하다. | 적용 근거 C2'),
     '[model-name-in-text]', 'E11_P102_beta.md:'),
    ('run id in a GC rater reason', lambda d: edit(d / GCF, Q21_C1, Q21_C1.replace('규칙 3에 따라 판단.', '규칙 3에 따라 판단 (syn_P102_beta).')),
     '[run-id-in-text]', 'E11_P102_beta.md:'),
    ('another model of models.json (not in this answer) in an element title', lambda d: edit(d / GCF, Q21_HEAD, '**Q2.1-01 효과 과대 기술 (Gamma 3 기준)** — 감점 기준:'),
     '[model-name-in-text]', 'E11_P102_beta.md:'),
]
for i_case, (label, mut, code, where) in enumerate(blind_cases):
    d = variant('blind-%d' % i_case, mut)
    bb, PP = build_in(d, 'syn3')
    ok('blinding: %s → %s at %s…, nothing built' % (label, code, where), bb is None and code in codes(PP) and where in codes(PP), PP.report())
d_w = variant('blind-warn', lambda d: edit(d / 'sources/ca/P101.md', '"1.2": "P101 답안가 환자 평가"', '"1.2": "P101 답안가 환자 평가: alpha-glucosidase 억제제, ChatGPT"'))
bw, Pw = build_in(d_w, 'syn3')
ok('blinding: a code inside a compound term (alpha-glucosidase) and a vendor word → warnings only, set builds',
   bw is not None and Pw.ok() and '[model-code-compound]' in Pw.report() and '[vendor-name-in-text]' in Pw.report(), Pw.report())
ok('blinding: the fixture answers carry no model code (neutral labels)', b3 is not None and not P3.warnings, P3.warnings)
from cases_lib import blinding  # noqa: E402
Pv = common.Problems()
mt = blinding.Matcher(common.load_models(Pv))
eq('blinding matcher: v1 names / codes / vendor words found, ordinary words not',
   [bool(mt.hits(x)) for x in ('GPT-6.1 Sol 은', 'gpt 6.1 sol', 'deepseek-v4.1-flash', '(gpt)', 'OpenAI', 'GLP-1 RA', 'egpt', 'claudication')],
   [True, True, True, True, True, False, False, False])
eq('blinding matcher: a hyphenated vendor/model code is an error, a generic code in a compound term is only a check',
   [[h[0] for h in mt.hits(x)] for x in ('DeepSeek-R1 기반', 'GPT-based 답변', 'gpt-4o', 'alpha-glucosidase')],
   [['code'], ['code'], ['code'], []])

# manifest lists a model by its name → the hint names the code (adding the model again would be a duplicate alias)
bn, Pn = build_in(variant('manname', lambda d: edit(d / 'sets/syn3.json', '"alpha"', '"Alpha One"')), 'syn3')
ok('manifest model given by name → [unknown-model] that names the code to write', bn is None and '[unknown-model]' in codes(Pn) and
   'code "alpha"' in codes(Pn) and 'models.json 에 모델을 추가' not in codes(Pn), Pn.report())

# a frozen set's archive never changes silently (e.g. a model renamed in models.json): refused unless --allow-frozen-change
frz = SCRATCH / 'frozen-cases'
shutil.copytree(common.CASES, frz)
edit(frz / 'models.json', '"name": "GPT-6.1 Sol"', '"name": "GPT-6.1-Sol (OpenAI)"')
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(frz), '--set', 'v1', '--check'], capture_output=True, text=True)
ok('frozen v1 + renamed model → [frozen-changed], exit 1, names the changed field', r.returncode == 1 and '[frozen-changed]' in r.stdout and 'model_name' in r.stdout, r.stdout[-700:])
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(frz), '--set', 'v1', '--check', '--allow-frozen-change'], capture_output=True, text=True)
ok('--allow-frozen-change → warning only, exit 0', r.returncode == 0 and '[frozen-changed]' in r.stdout, r.stdout[-500:])

# one patient × several models, explicit Types with the same patient in a Type, CA only ("gc": false) — the P051 4-model design
def _one_patient(d):
    (d / 'sets/one3.json').write_text(json.dumps({
        "id": "one3", "status": "draft", "title": {"ko": "한 환자 × 3 모델", "en": "One patient × 3 models"},
        "patients": ["P101"], "models": ["alpha", "beta", "gamma"],
        "ca": {"per_session": 2, "minutes_per_unit": [10, 15], "types": [
            {"id": "A", "sequences": [["P101_alpha", "P101_beta"], ["P101_beta", "P101_alpha"]]},
            {"id": "B", "sequences": [["P101_gamma", "P101_alpha"], ["P101_alpha", "P101_gamma"]]}]},
        "gc": False}, ensure_ascii=False, indent=2), encoding='utf-8')
bo, Po = build_in(variant('one-patient', _one_patient), 'one3')
ok('one patient × 3 models, explicit same-patient Types, CA only → builds', bo is not None and Po.ok(), Po.report())
if bo:
    eq('…Types kept exactly as written', [t['sequences'] for t in bo.design['ca']['types']],
       [[["P101_alpha", "P101_beta"], ["P101_beta", "P101_alpha"]], [["P101_gamma", "P101_alpha"], ["P101_alpha", "P101_gamma"]]])
    ok('…no GC design for a CA-only set', not bo.design.get('gc'), bo.design.get('gc'))
    eq('…CA data has the one patient and 3 answers', (sorted(bo.ca_data['patients']), sorted(bo.ca_data['outputs'])),
       (['P101'], ['P101_alpha', 'P101_beta', 'P101_gamma']))

# freezing a set for the first time (draft → frozen) is not a content change; a later content change still is
fz = SCRATCH / 'freeze-first'
shutil.copytree(FIX, fz / 'cases')
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(fz / 'cases'), '--out', str(fz / 'out'), '--set', 'syn3', '--no-gas', '--quiet'],
                   capture_output=True, text=True)
ok('fixture set builds into a scratch output root', r.returncode == 0, r.stdout[-400:] + r.stderr[-400:])
edit(fz / 'cases/sets/syn3.json', '"status": "draft"', '"status": "frozen"')
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(fz / 'cases'), '--out', str(fz / 'out'), '--set', 'syn3', '--no-gas', '--check'],
                   capture_output=True, text=True)
ok('freezing a set (status draft → frozen) does not trip [frozen-changed]', r.returncode == 0 and '[frozen-changed]' not in r.stdout, r.stdout[-600:])
edit(fz / 'cases/sources/ca/P101.md', '"1.2": "P101 답안가 환자 평가"', '"1.2": "P101 답안가 환자 평가 (수정)"')
r = subprocess.run([sys.executable, str(HERE / 'build_cases.py'), '--cases', str(fz / 'cases'), '--out', str(fz / 'out'), '--set', 'syn3', '--no-gas', '--check'],
                   capture_output=True, text=True)
ok('…but a content change of the now-frozen set is refused', r.returncode == 1 and '[frozen-changed]' in r.stdout, r.stdout[-600:])

# GC backend JSON too large for the Apps Script cache → warning (still builds)
ok('v1 GC backend JSON is far below the cache limit', len((ROOT / 'gc/data/sets/v1.json').read_text(encoding='utf-8')) < build.GC_CACHE_MAX_CHARS / 2)
_lim = build.GC_CACHE_MAX_CHARS
build.GC_CACHE_MAX_CHARS = 1000
try:
    b_big, P_big = build_in(FIX, 'syn3')
finally:
    build.GC_CACHE_MAX_CHARS = _lim
ok('GC backend JSON over the cache limit → [gc-json-large] warning, set still builds', b_big is not None and P_big.ok() and '[gc-json-large]' in P_big.report(), P_big.report())

shutil.rmtree(SCRATCH, ignore_errors=True)
print('\n%d passed, %d failed' % (passed, failed))
sys.exit(1 if failed else 0)
