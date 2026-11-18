"""Parse the CDSS output markdown (4 AI outputs + 2 patient vignettes) into data/cases.json."""
import json, re, sys

src = sys.argv[1]
out = sys.argv[2]
raw = open(src, encoding="utf-8").read()
text = raw.replace("**", "")
lines = text.split("\n")

# Locate section headers
heads = []
for i, l in enumerate(lines):
    s = l.strip().lstrip("#").strip()
    m = re.match(r"^(P0\d\d)\s+Deepseek V4\.1 Flash$", s, re.I)
    if m: heads.append((i, "json", m.group(1), "deepseek")); continue
    m = re.match(r"^GPT\s*6\.1 Sol\s+(P0\d\d)$", s, re.I)
    if m: heads.append((i, "json", m.group(1), "gpt")); continue
    m = re.match(r"^(P0\d\d) Patient Input Information$", s, re.I)
    if m: heads.append((i, "patient", m.group(1), None)); continue
heads.append((len(lines), "end", None, None))
print(heads)

outputs, patients = {}, {}
for k in range(len(heads) - 1):
    start, kind, pid, model = heads[k]
    end = heads[k + 1][0]
    body = "\n".join(lines[start + 1:end])
    if kind == "json":
        # first line of P051 block is "#  {" -> strip leading '#'
        body = re.sub(r"^\s*#\s*\{", "{", body.strip(), count=1)
        obj = json.loads(body)
        outputs[f"{pid}_{model}"] = obj
    else:
        patients[pid] = body.strip()

json.dump({"outputs": outputs, "patients_raw": patients}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for key, o in outputs.items():
    print(key, list(o.keys()), [c.get("name") for c in o["combinations"]])
    for c in o["combinations"]:
        print("   answers keys:", list(c["answers"].keys()), "| rx keys:", list(c["prescription"][0].keys()), "n_rx", len(c["prescription"]))
    print("   phase1:", {kk: (type(v).__name__) for kk, v in o["phase_1"].items()})
