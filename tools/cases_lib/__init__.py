"""Modular case pipeline (cases/ → data/, gc/data/, gas/).

  common.py    paths, JSON helpers, the model registry (cases/models.json) and the Problems collector
  ca_parse.py  CDSS output documents (CA sources) → patients + outputs  (was tools/parse_md.py + tools/build_data.py)
  gc_parse.py  채점·감사 검증 reports (GC sources) → flagged items      (was tools/build_gc_data.py)
  design.py    Type/Part generator (units = patient × model, counterbalanced orders, minute estimates)
  validate.py  checks every input before anything is written

Entry point: tools/build_cases.py (see cases/README.md).
"""
