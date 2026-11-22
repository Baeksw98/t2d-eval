#!/usr/bin/env python3
"""(Legacy wrapper) Parse CDSS output markdown into the intermediate JSON {outputs, patients_raw}.

    python3 tools/parse_md.py <source.md> <out.json>

The case pipeline now does this inside tools/build_cases.py (tools/cases_lib/ca_parse.py; model names via
cases/models.json). This wrapper is kept for ad-hoc inspection: for the v1 source it writes exactly the (git-ignored, local)
data/parsed_raw.json.
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
outputs, patients, _ = ca_parse.parse_sources([pathlib.Path(sys.argv[1])], models, P)
print(P.report('parse_md:'))
if not P.ok():
    sys.exit(1)
json.dump({"outputs": outputs, "patients_raw": patients}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for key, o in outputs.items():
    print(key, [c.get("name") for c in o.get("combinations", [])])
