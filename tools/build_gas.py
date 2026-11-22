"""Build the two Apps Script files that are pasted into Apps Script (two SEPARATE projects, two spreadsheets).

  gas/Code.gs    CA (clinical acceptability, site /):  gas/src/core.gs + gas/src/*.gs, plain concatenation exactly as
                 before (byte-identical output for unchanged sources; the CA project must not need a redeploy).
  gas/GcCode.gs  GC (guideline-concordance physician validation, site /gc/, docs/GC_CONTRACT.md):
                   1. gas/gc/gc_main.gs  — Korean deployment header, GC_SPREADSHEET_ID, entry points
                                           (doGet, doPost, setup, onOpen, refreshGcSummaryIfDirty, …)
                   2. gas/gc/*.gs        — the GC backend (actions, GC_* sheets, buildGcSummary)
                   3. shared helpers     — copied from gas/src/*.gs by NAME (see below)
                   4. var GC_ITEMS = {…} — the ACTIVE case set's backend copy gc/data/sets/<id>.json (tools/build_cases.py);
                                           the backend fetches every set from the site at run time, this is the fallback

Why named-helper extraction (and not a shared lib file or hand-made copies):
  - Splitting gas/src/core.gs into lib files would change gas/Code.gs (order/content), and the CA script must stay
    byte-identical to the deployed one.
  - Hand-copying sheet/summary utilities (table_/tWrite_/cell_/sm_write_/sm_wilson_ …) into gas/gc would let the two
    projects drift apart silently.
  - So the GC build takes the top-level declarations of gas/src/*.gs that the GC sources actually reference, plus their
    own dependencies (transitive closure over identifiers, with comments/strings/regex literals stripped first).
    Names defined in gas/gc always win (a GC entry point such as doPost is never taken from CA).
Guarantees checked here (the build fails otherwise):
  - no top-level name is declared twice in either output file;
  - no CA entry point, CA trigger or CA spreadsheet setting is pulled into GcCode.gs (CA_ONLY below);
  - every function copied from CA ends with '_' (private in Apps Script → never shown in the Run dropdown of the GC
    project, never callable via google.script.run). The GC project's dropdown therefore lists only GC functions.
"""
import json
import pathlib
import re
import sys

base = pathlib.Path(__file__).resolve().parent.parent
root = base / 'gas'
GC_SRC = base / 'gc' / 'data' / 'gc_items.js'

# CA declarations that must never be part of the GC project (entry points, triggers, CA spreadsheet/version settings).
CA_ONLY = {
    'doGet', 'doPost', 'setup', 'onOpen', 'showCounter', 'buildSummary', 'buildSummaryIncludingTests',
    'refreshSummaryIfDirty', 'ensureSummaryTrigger_', 'sm_clearDirty_', 'ss_', 'handleView_', 'handleStart_',
    'logRaw_', 'SPREADSHEET_ID', 'BACKEND_VERSION', 'EXPECTED_STUDY_ID', 'VALID_ACTIONS',
}
KEYWORDS_BEFORE_REGEX = {'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'do', 'instanceof'}


# ---------------------------------------------------------------------------------------------------------------
# Minimal top-level JS scanner (ES5 Apps Script style): strips comments / strings / regex literals and splits the
# file into top-level `function NAME(...) {...}` and `var NAME = ...;` declarations.
# ---------------------------------------------------------------------------------------------------------------
def scan(src):
    """Return (code_mask, decls). code_mask = src with comments/strings/regex bodies replaced by spaces (same length,
    newlines kept). decls = [(name, kind, start_offset, end_offset)] for depth-0 declarations."""
    out = list(src)
    n = len(src)
    i = 0
    depth = 0
    prev = ''           # last significant token class: 'id:<word>', 'num', ')', ']', '}', or an operator char
    decls = []
    cur = None          # [name, kind, start, depth_at_start]

    def blank(a, b):
        for k in range(a, b):
            if out[k] != '\n':
                out[k] = ' '

    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
            continue
        if c in '\'"`':
            j = i + 1
            while j < n and src[j] != c:
                j += 2 if src[j] == '\\' else 1
            blank(i + 1, j)
            i = j + 1
            prev = 'str'
            continue
        if c == '/':
            is_regex = not (prev in (')', ']', '}', 'num', 'str') or (prev.startswith('id:') and prev[3:] not in KEYWORDS_BEFORE_REGEX))
            if is_regex:
                j = i + 1
                in_class = False
                while j < n:
                    ch = src[j]
                    if ch == '\\':
                        j += 2
                        continue
                    if ch == '[':
                        in_class = True
                    elif ch == ']':
                        in_class = False
                    elif ch == '/' and not in_class:
                        break
                    elif ch == '\n':
                        raise SystemExit('build_gas.py: unterminated regex literal near offset %d' % i)
                    j += 1
                blank(i + 1, j)
                j += 1
                while j < n and src[j].isalpha():   # flags
                    j += 1
                i = j
                prev = 'str'
                continue
            prev = '/'
            i += 1
            continue
        m = re.match(r'[A-Za-z_$][\w$]*', src[i:i + 200])
        if m:
            word = m.group(0)
            if depth == 0 and cur is None and word in ('function', 'var'):
                nm = re.match(r'(?:function|var)\s+([A-Za-z_$][\w$]*)', src[i:i + 300])
                if nm:
                    cur = [nm.group(1), word, i]
            prev = 'id:' + word
            i += len(word)
            continue
        if c.isdigit():
            m = re.match(r'[0-9.eExXa-fA-F]+', src[i:])
            i += len(m.group(0))
            prev = 'num'
            continue
        if c in '{[(':
            depth += 1
        elif c in '}])':
            depth -= 1
            if depth < 0:
                raise SystemExit('build_gas.py: unbalanced brackets near offset %d' % i)
            if depth == 0 and cur is not None and cur[1] == 'function' and c == '}':
                decls.append((cur[0], 'function', cur[2], i + 1))
                cur = None
        elif c == ';' and depth == 0 and cur is not None and cur[1] == 'var':
            decls.append((cur[0], 'var', cur[2], i + 1))
            cur = None
        prev = c
        i += 1
    if depth != 0 or cur is not None:
        raise SystemExit('build_gas.py: could not parse top level (depth %d, open %r)' % (depth, cur))
    return ''.join(out), decls


def identifiers(code):
    """Identifiers used in code (comments/strings already blanked); property names after '.' are ignored."""
    return set(m.group(1) for m in re.finditer(r'(?<![\w$.])([A-Za-z_$][\w$]*)', code)) - {'function', 'var'}


def chunk_text(src, start, end):
    """Declaration text from the start of its line to the end of its last line (keeps a trailing // comment) plus a
    directly preceding /** … */ doc comment."""
    ls = src.rfind('\n', 0, start) + 1
    le = src.find('\n', end)
    le = len(src) if le < 0 else le
    text = src[ls:le]
    before = src[:ls].rstrip(' \t')
    if before.endswith('*/\n') or before.endswith('*/'):
        k = before.rfind('/**')
        if k >= 0 and '\n\n' not in before[k:]:
            text = before[k:].rstrip('\n') + '\n' + text
    return text


def top_names(src):
    return [d[0] for d in scan(src)[1]]


def check_unique(label, names):
    seen, dup = set(), []
    for x in names:
        if x in seen:
            dup.append(x)
        seen.add(x)
    if dup:
        raise SystemExit('build_gas.py: %s declares these top-level names more than once: %s' % (label, ', '.join(sorted(set(dup)))))


# ---------------------------------------------------------------------------------------------------------------
# GC_ITEMS block
# ---------------------------------------------------------------------------------------------------------------
def js_json(obj):
    """Compact JSON that is also a valid JS literal (escape U+2028/2029, which older JS parsers reject)."""
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':')).replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')


def gc_block():
    """GC_ITEMS = the active set's backend copy gc/data/sets/<set_id>.json (written by tools/build_cases.py; the same shape
    the GC backend fetches from the site at run time, so this embedded copy is only the fallback)."""
    src = GC_SRC.read_text(encoding='utf-8')
    marker = 'window.GC_DATA = '
    body = src[src.index(marker) + len(marker):].strip()
    if body.endswith(';'):
        body = body[:-1]
    site = json.loads(body)
    set_id = site.get('set_id') or 'v1'
    set_json = base / 'gc' / 'data' / 'sets' / (set_id + '.json')
    if not set_json.exists():
        raise SystemExit('build_gas.py: %s is missing — run `python3 tools/build_cases.py` first (it writes the GC backend copy '
                         'of every case set)' % set_json.relative_to(base))
    data = json.loads(set_json.read_text(encoding='utf-8'))
    if data.get('set_id') != set_id or data.get('data_version') != site.get('data_version') or list(data['units']) != list(site['units']):
        raise SystemExit('build_gas.py: gc/data/gc_items.js (set %s, %s) and %s (set %s, %s) disagree — run `python3 tools/build_cases.py`'
                         % (set_id, site.get('data_version'), set_json.relative_to(base), data.get('set_id'), data.get('data_version')))
    units, stats = data['units'], []
    for key, u in units.items():
        stats.append('%s %d items / %d targets' % (key, len(u['items']), len(u['concordance_base'])))
    lines = [
        '// ============================================================',
        '// GC_ITEMS — GENERATED by tools/build_gas.py from gc/data/sets/<active set>.json (tools/build_cases.py). Do not edit here.',
        '// The backend reads each case set from the site at run time (gcSetData_); this copy of the ACTIVE set at build time is',
        '// only the fallback when the site cannot be reached. Content changes therefore do not need a repaste.',
        '// ============================================================',
        'var GC_ITEMS = {',
        '  set_id: ' + js_json(set_id) + ',',
        '  data_version: ' + js_json(data.get('data_version', '')) + ',',
        '  scope: ' + js_json(data.get('scope', '')) + ',',
        '  parts: ' + js_json(data.get('parts') or []) + ',',
        '  units: {',
    ]
    keys = list(units)
    for i, k in enumerate(keys):
        lines.append('    ' + js_json(k) + ': ' + js_json(units[k]) + (',' if i < len(keys) - 1 else ''))
    lines += ['  }', '};']
    total = sum(len(u['items']) for u in units.values())
    return '\n'.join(lines) + '\n', data.get('data_version', ''), total, stats


# ---------------------------------------------------------------------------------------------------------------
# 1) CA: gas/Code.gs (unchanged recipe)
# ---------------------------------------------------------------------------------------------------------------
ca_parts = [root / 'src' / 'core.gs'] + sorted(p for p in (root / 'src').glob('*.gs') if p.name != 'core.gs')
ca_out = '\n'.join(p.read_text(encoding='utf-8').rstrip() + '\n' for p in ca_parts)
check_unique('gas/Code.gs', top_names(ca_out))
(root / 'Code.gs').write_text(ca_out, encoding='utf-8')
print('built gas/Code.gs (CA) from', [p.name for p in ca_parts], len(ca_out.splitlines()), 'lines')

# ---------------------------------------------------------------------------------------------------------------
# 2) GC: gas/GcCode.gs
# ---------------------------------------------------------------------------------------------------------------
gc_parts = [root / 'gc' / 'gc_main.gs'] + sorted(p for p in (root / 'gc').glob('*.gs') if p.name != 'gc_main.gs')
gc_src = '\n'.join(p.read_text(encoding='utf-8').rstrip() + '\n' for p in gc_parts)
gc_items, gc_version, gc_total, gc_stats = gc_block()
gc_mask, gc_decls = scan(gc_src + '\n' + gc_items)
gc_defined = set(d[0] for d in gc_decls)

# CA declarations by name (later files cannot redefine earlier names: Code.gs uniqueness is checked above)
ca_decl = {}
for p in ca_parts:
    s = p.read_text(encoding='utf-8')
    mask, decls = scan(s)
    for name, kind, a, b in decls:
        ca_decl[name] = {'kind': kind, 'file': p.name, 'text': chunk_text(s, a, b), 'uses': identifiers(mask[a:b]), 'order': len(ca_decl)}

need, queue = [], sorted(n for n in identifiers(gc_mask) if n in ca_decl and n not in gc_defined)
seen = set()
while queue:
    nm = queue.pop(0)
    if nm in seen:
        continue
    seen.add(nm)
    need.append(nm)
    for u in sorted(ca_decl[nm]['uses']):
        if u in ca_decl and u not in gc_defined and u not in seen and u != nm:
            queue.append(u)
bad = sorted(n for n in need if n in CA_ONLY)
if bad:
    raise SystemExit('build_gas.py: the GC build would pull CA-only declarations: %s — give GC its own version in gas/gc/' % ', '.join(bad))
public = sorted(n for n in need if ca_decl[n]['kind'] == 'function' and not n.endswith('_'))
if public:
    raise SystemExit('build_gas.py: CA functions without a trailing "_" would appear in the GC Run dropdown: %s' % ', '.join(public))

need.sort(key=lambda n: ca_decl[n]['order'])
helpers_by_file = {}
for n in need:
    helpers_by_file.setdefault(ca_decl[n]['file'], []).append(n)
shared = [
    '// ============================================================',
    '// SHARED HELPERS — copied by tools/build_gas.py from the CA sources (gas/src/*.gs), only the ones GC uses.',
    '// Do not edit here: change gas/src/*.gs (CA) or gas/gc/*.gs (GC) and re-run `python3 tools/build_gas.py`.',
    '// ' + '; '.join('%s: %d' % (f, len(v)) for f, v in helpers_by_file.items()),
    '// ============================================================',
]
shared_text = '\n'.join(shared) + '\n' + '\n\n'.join(ca_decl[n]['text'] for n in need) + '\n'
gc_out = gc_src + '\n' + shared_text + '\n' + gc_items
gc_names = top_names(gc_out)
check_unique('gas/GcCode.gs', gc_names)
leak = sorted(set(gc_names) & CA_ONLY - gc_defined)
if leak:
    raise SystemExit('build_gas.py: CA-only names in gas/GcCode.gs: %s' % ', '.join(leak))
missing = sorted(n for n in identifiers(scan(gc_out)[0]) if n in ca_decl and n not in set(gc_names))
if missing:
    raise SystemExit('build_gas.py: unresolved CA helpers in gas/GcCode.gs: %s' % ', '.join(missing))
(root / 'GcCode.gs').write_text(gc_out, encoding='utf-8')
entry = [n for n in gc_names if not n.endswith('_') and n == n.strip() and re.match(r'^[a-z]', n)
         and n in set(d[0] for d in gc_decls if d[1] == 'function')]
print('built gas/GcCode.gs (GC) from', [p.name for p in gc_parts], '+', len(need), 'shared helpers',
      '(' + ', '.join('%s %d' % (f, len(v)) for f, v in helpers_by_file.items()) + ') + GC_ITEMS,',
      len(gc_out.splitlines()), 'lines')
print('  GC Run-dropdown functions:', ', '.join(entry))
print('  GC_ITEMS (embedded fallback) from gc/data/sets/<active set>.json: data_version %s, %d flagged items (%s)' % (gc_version, gc_total, '; '.join(gc_stats)))
