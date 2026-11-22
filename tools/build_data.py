#!/usr/bin/env python3
"""(Legacy wrapper) Build a window.T2D_DATA file from the intermediate JSON written by tools/parse_md.py.

    python3 tools/build_data.py <parsed_raw.json> <out.js>

Use tools/build_cases.py for the site: it writes data/cases.js (active set, with set_id) and data/sets/<id>/cases.js
from cases/. This wrapper keeps the old command working (same patient parser, model names from cases/models.json).
"""
import json
import pathlib
import sys

sys.dont_write_bytecode = True   # no __pycache__ in the repository
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from cases_lib import ca_parse, common  # noqa: E402

if len(sys.argv) != 3:
    sys.exit(__doc__)
P = common.Problems()
models = common.load_models(P)
d = json.load(open(sys.argv[1], encoding="utf-8"))
patients = ca_parse.build_patients(d["patients_raw"], {}, P)
outputs = {k: ca_parse.build_output(k, o, models) for k, o in d["outputs"].items()}
print(P.report('build_data:'))
if not P.ok():
    sys.exit(1)
data = {"data_version": "2026-11-18.v1", "patients": patients, "outputs": outputs}
open(sys.argv[2], "w", encoding="utf-8").write(common.window_js('T2D_DATA', data, 'tools/build_data.py'))
print('wrote', sys.argv[2], '-', len(patients), 'patients,', len(outputs), 'outputs')
