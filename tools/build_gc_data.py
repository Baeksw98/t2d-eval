#!/usr/bin/env python3
"""(Legacy wrapper) Build a window.GC_DATA file from scoring/audit verification markdown (one or more reports).

    python3 tools/build_gc_data.py <source.md> <out.js>

The site's gc/data/gc_items.js is now written by tools/build_cases.py from cases/sources/gc/ (set-aware, with set_id
and the frozen data_version of each set). This wrapper keeps the parser usable on its own (tools/cases_lib/gc_parse.py,
model names via cases/models.json) and no longer overwrites gc/data/gc_items.js unless that path is given explicitly.
"""
import datetime
import pathlib
import sys

sys.dont_write_bytecode = True   # no __pycache__ in the repository
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from cases_lib import common, gc_parse  # noqa: E402

if len(sys.argv) != 3:
    sys.exit(__doc__)
P = common.Problems()
models = common.load_models(P)
units = gc_parse.parse(pathlib.Path(sys.argv[1]), models, P)
print(P.report('build_gc_data:'), file=sys.stderr)
if not P.ok():
    sys.exit(1)
out = {'data_version': datetime.date.today().isoformat() + '.gc2', 'scope': gc_parse.SCOPE,
       'units': {u['key']: gc_parse.unit_record(u) for u in units}}
for u in units:
    n = len(u['items'])
    mj = sum(1 for i in u['items'] if i['audit']['mark'] == 'major')
    print('%-15s %2d items (✗ %d, △ %d)' % (u['key'], n, mj, n - mj), file=sys.stderr)
open(sys.argv[2], 'w', encoding='utf-8').write(common.window_js('GC_DATA', out, 'tools/build_gc_data.py'))
