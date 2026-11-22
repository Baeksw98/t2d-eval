#!/usr/bin/env python3
"""Build the evaluation data from cases/ (the source of truth) — see cases/README.md.

  python3 tools/build_cases.py                  validate every set, write every set's archive + the active set, run build_gas.py
  python3 tools/build_cases.py --set v2 --check validate set v2 and show its Types/Parts and what would change; writes nothing
  python3 tools/build_cases.py --set v2         write set v2's archive only (and the active files if v2 is the active set)
  options: --check (dry run) · --no-gas (do not run tools/build_gas.py) · --quiet
           --allow-frozen-change  rewrite the archive of a set whose manifest says "status": "frozen" (refused otherwise)

Inputs   cases/models.json, cases/active.json, cases/sets/<id>.json, cases/sources/ca/*.md, cases/sources/gc/*.md
Outputs  (contract: docs/DATA_CONTRACT.md · docs/GC_CONTRACT.md)
  every set   data/sets/<id>/cases.js       window.T2D_DATA   (patients + CDSS outputs, set_id)
              data/sets/<id>/design.js      window.T2D_DESIGN (units, CA Types, GC Parts, minutes)
              gc/data/sets/<id>/gc_items.js window.GC_DATA    (flagged judgments, set_id)
              gc/data/sets/<id>.json        compact GC copy read by the GC Apps Script (no repaste for content changes)
              gc/data/sets/index.json       {active, sets}: tells the GC Apps Script which set is active now
  active set  data/cases.js · data/design.js · gc/data/gc_items.js (same content as its archive)
  then        tools/build_gas.py → gas/Code.gs (unchanged by data) and gas/GcCode.gs (embedded fallback = active set)
Nothing is written when any set has an error. Exit code 1 on errors.
Frozen sets ("status": "frozen", e.g. v1 = the live study): when an existing archive file of such a set would change in
content (header comment aside) — for instance after editing cases/models.json (a model name), a parser or the generator —
the build stops with [frozen-changed] and writes nothing. Sessions in progress and the analysis rely on that data.
"""
import argparse
import hashlib
import pathlib
import re
import subprocess
import sys

sys.dont_write_bytecode = True   # no __pycache__ in the repository
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from cases_lib import build, common  # noqa: E402


def structural_diff(old, new, path='', out=None, limit=12):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(old, dict) and isinstance(new, dict):
        for k in list(old.keys()) + [k for k in new if k not in old]:
            if k not in new:
                out.append('- %s%s' % (path, k))
            elif k not in old:
                out.append('+ %s%s' % (path, k))
            else:
                structural_diff(old[k], new[k], '%s%s.' % (path, k), out, limit)
            if len(out) >= limit:
                break
    elif isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        for i, (a, b) in enumerate(zip(old, new)):
            structural_diff(a, b, '%s%d.' % (path, i), out, limit)
    elif old != new:
        out.append('~ %s' % path.rstrip('.'))
    return out


# Pages that load the active set's data files. Their ?v= cache stamps are set from the active files' content, so a rebuilt
# or switched set reaches browsers at once instead of mixing a cached cases.js with a fresh design.js (Pages caches ~10 min).
STAMP_PAGES = ['index.html', 'about/index.html', 'ca/index.html', 'gc/index.html',
               'qr/index.html', 'qr/main/index.html', 'qr/ca/index.html', 'qr/gc/index.html']
STAMP_RE = re.compile(r'((?:\.\./)*data/(?:cases|design|gc_items)\.js)\?v=[A-Za-z0-9._-]*')


def stamp_pages(out_root, active, active_files):
    """{page: new html} with every active data file's ?v= set to '<set>.<content hash>' (pages missing under out_root skipped)."""
    h = hashlib.sha1(''.join(active_files[k] for k in sorted(active_files)).encode('utf-8')).hexdigest()[:8]
    stamp = '%s.%s' % (active, h)
    out = {}
    for relp in STAMP_PAGES:
        fp = out_root / relp
        if fp.exists():
            out[relp] = STAMP_RE.sub(lambda m: m.group(1) + '?v=' + stamp, fp.read_text(encoding='utf-8'))
    return out, stamp


def parse_text(rel_path, text):
    import json
    if rel_path.endswith('.json'):
        return json.loads(text)
    body = text[text.index(' = ') + 3:].strip().rstrip(';')
    return json.loads(body)


def frozen_check(b, out_root, P, allow):
    """A frozen set's existing archive files must not change in content (the header comment is ignored)."""
    changed = []
    for relp, text in sorted(b.files().items()):
        fp = out_root / relp
        if not fp.exists():
            continue                     # first build of this set: nothing to protect yet
        old = fp.read_text(encoding='utf-8')
        if old == text:
            continue
        try:
            same = parse_text(relp, old) == parse_text(relp, text)
            diff = [] if same else structural_diff(parse_text(relp, old), parse_text(relp, text), limit=4)
        except Exception:   # noqa: BLE001 — unreadable old file counts as a change
            same, diff = False, ['(내용 비교 불가)']
        if not same:
            changed.append('%s (%s)' % (relp, '; '.join(diff)))
    if not changed:
        return
    if allow:
        P.warn(b.man['where'], '동결된 세트 %s 의 보관본이 바뀝니다 (--allow-frozen-change): %s [frozen-changed]' % (b.id, ' · '.join(changed)))
        return
    P.error(b.man['where'], '동결된 세트 %s ("status": "frozen") 의 보관본 내용이 바뀌게 됩니다: %s [frozen-changed]' % (b.id, ' · '.join(changed)),
            '이 세트로 진행 중인 세션과 분석이 이 자료를 씁니다. cases/models.json(모델 name 등)·원본·파서 변경이 원인이면 되돌리세요. '
            '정말 바꿔야 하면 새 세트 ID 로 만들거나, 연구책임자와 확인한 뒤 --allow-frozen-change 로 다시 실행하세요')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--set', dest='set_id', help='build only this set (default: every set in cases/sets)')
    ap.add_argument('--check', action='store_true', help='validate and show what would change; write nothing')
    ap.add_argument('--no-gas', action='store_true', help='do not run tools/build_gas.py afterwards')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--allow-frozen-change', action='store_true', help='allow rewriting the archive of a frozen set')
    ap.add_argument('--cases', default=str(common.CASES), help=argparse.SUPPRESS)   # tests: fixture cases dir
    ap.add_argument('--out', default=str(common.ROOT), help=argparse.SUPPRESS)      # tests: output root
    a = ap.parse_args(argv)
    cases_dir, out_root = pathlib.Path(a.cases), pathlib.Path(a.out)
    say = (lambda *x: None) if a.quiet else print

    P = common.Problems()
    models = common.load_models(P, cases_dir / 'models.json')
    active = build.active_set(P, cases_dir)
    all_sets = build.list_sets(cases_dir)
    if a.set_id and a.set_id not in all_sets:
        P.error('cases/sets', '세트 "%s" 가 없습니다. 있는 세트: %s [unknown-set]' % (a.set_id, ', '.join(all_sets) or '(없음)'),
                'cases/sets/%s.json 을 만드세요 (cases/README.md 참고)' % a.set_id)
    wanted = [a.set_id] if a.set_id else all_sets
    builds = {}
    if P.ok():
        for sid in wanted:
            b = build.build_set(sid, models, P, cases_dir)
            if b:
                builds[sid] = b
                for line in build.summary_lines(b):
                    say(line)
                say('')
    if active and active in builds and builds[active].gc_data is None:
        P.error('cases/active.json', '활성 세트 "%s" 에 GC 자료가 없습니다 ("gc": false) — /gc/ 화면이 동작하지 않습니다 [active-without-gc]' % active)
    for sid, b in builds.items():
        if b.man['status'] == 'frozen':
            frozen_check(b, out_root, P, a.allow_frozen_change)

    print(P.report('검증 결과 (validation):'))
    if not P.ok():
        print('\n✗ 오류가 있어 아무 파일도 쓰지 않았습니다. 위 메시지를 고친 뒤 다시 실행하세요.')
        return 1

    files = {}
    for sid, b in builds.items():
        files.update(b.files())
    stamp = None
    if active in builds:
        act = builds[active].active_files()
        files.update(act)
        pages, stamp = stamp_pages(out_root, active, act)
        files.update(pages)
    files['gc/data/sets/index.json'] = build.index_json(active, cases_dir)
    say('\n활성 세트 (cases/active.json): %s%s' % (active, '' if active in builds else '  (이번에 빌드하지 않음 → data/cases.js 등은 그대로)'))

    changed = []
    for relp in sorted(files):
        fp = out_root / relp
        old = fp.read_text(encoding='utf-8') if fp.exists() else None
        if old == files[relp]:
            say('  = %s' % relp)
            continue
        changed.append(relp)
        if old is None:
            say('  + %s (새 파일)' % relp)
            continue
        if relp.endswith('.html'):
            say('  ~ %s  (활성 세트 자료의 캐시 표시 ?v=%s)' % (relp, stamp))
            continue
        try:
            diff = structural_diff(parse_text(relp, old), parse_text(relp, files[relp]))
        except Exception:   # noqa: BLE001 — old file is not parseable data
            diff = ['(내용 비교 불가)']
        say('  ~ %s%s' % (relp, ('  구조 차이: ' + '; '.join(diff)) if diff else '  (데이터 동일, 머리말·서식만 다름)'))

    if a.check:
        print('\n--check: 파일을 쓰지 않았습니다. 바뀔 파일 %d개.' % len(changed))
        return 0
    for relp in changed:
        fp = out_root / relp
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(files[relp], encoding='utf-8')
    print('\n%d개 파일을 썼습니다 (바뀐 파일만).' % len(changed))
    if not a.no_gas and out_root.resolve() == common.ROOT:
        r = subprocess.run([sys.executable, str(common.ROOT / 'tools' / 'build_gas.py')], cwd=str(common.ROOT))
        if r.returncode:
            print('✗ tools/build_gas.py 실패')
            return r.returncode
    return 0


if __name__ == '__main__':
    sys.exit(main())
