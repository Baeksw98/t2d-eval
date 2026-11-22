"""Type / Part generator.

Unit  = one AI answer = patient × model (key 'P051_gpt').
Block = the units one evaluator sees in one session (a CA Type, a GC Part), per_session units each.

make_blocks(units, patients, models, k):
  * every unit appears equally often over all blocks: r = k / gcd(n, k) copies of each unit, n·r / k blocks
    (n = number of units; with k dividing n every unit appears once);
  * inside a block the patients are distinct and the models are distinct where possible
    (at most ceil(k / #patients) units of one patient and ceil(k / #models) of one model; relaxed one step at a time only
    if no assignment exists, and the relaxation is reported);
  * units are taken in diagonal (Latin-square) order of the manifest's patient and model lists — unit (p_i, m_j) has
    diagonal (j − i) mod M — so for P = M = k the blocks are the diagonals of the patient × model grid;
  * a block's base order is by model order, then patient order; its sequences are the counterbalanced orders of a
    Williams design (k = 2: base and reversed; even k: k orders; odd k: 2k orders), so each unit is shown in each
    position equally often and every unit follows every other unit equally often.
For set v1 (patients [P051, P011], models [deepseek, gpt], k = 2) this gives exactly the live study's
Type/Part A = [[P051_deepseek, P011_gpt], [P011_gpt, P051_deepseek]] and B = [[P011_deepseek, P051_gpt], [P051_gpt, P011_deepseek]]
(tools/test_cases.py checks it).

GC Parts use the same generator over the units that have flagged judgments; a Part's estimated time is
items × minutes_per_item rounded down to 5 minutes, as a 5-minute range ('20–25분'; 5–10 when it is 5 minutes or less).
"""
import math


def letters(i):
    """0 → A, 25 → Z, 26 → AA …"""
    s = ''
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def williams(k):
    """Counterbalanced orders (index lists) of a Williams design for k items."""
    if k <= 1:
        return [[0]] if k == 1 else []
    first, lo, hi = [0], 1, k - 1
    while len(first) < k:
        first.append(lo)
        lo += 1
        if len(first) < k:
            first.append(hi)
            hi -= 1
    rows = [[(x + i) % k for x in first] for i in range(k)]
    if k % 2:
        rows += [list(reversed(r)) for r in rows]
    return rows


def split_key(key):
    p, m = key.split('_', 1)
    return p, m


def _search(order, k, r, cap_p, cap_m, budget):
    queue = [u for _ in range(r) for u in order]
    used = [False] * len(queue)
    blocks, cur = [], []
    nodes = [0]

    def ok(u):
        p, m = split_key(u)
        if u in cur:
            return False
        if sum(1 for x in cur if split_key(x)[0] == p) >= cap_p:
            return False
        if sum(1 for x in cur if split_key(x)[1] == m) >= cap_m:
            return False
        return True

    def fill(start):
        nodes[0] += 1
        if nodes[0] > budget:
            raise TimeoutError
        if len(cur) == k:
            blocks.append(list(cur))
            del cur[:]
            if all(used):
                return True
            saved = blocks[-1]
            if fill(0):
                return True
            blocks.pop()
            cur[:] = saved
            return False
        if not cur:
            # the first unit of a new block is always the earliest unused one (blocks are unordered sets)
            i = used.index(False)
            used[i] = True
            cur.append(queue[i])
            if fill(i + 1):
                return True
            cur.pop()
            used[i] = False
            return False
        tried = set()
        for i in range(start, len(queue)):
            u = queue[i]
            if used[i] or u in tried or not ok(u):
                continue
            tried.add(u)
            used[i] = True
            cur.append(u)
            if fill(i + 1):
                return True
            cur.pop()
            used[i] = False
        return False

    try:
        return blocks if fill(0) else None
    except TimeoutError:
        return None


def make_blocks(units, patients, models, k):
    """Returns (blocks, notes): blocks = [[unit key, …] in base order]; notes = human-readable remarks (relaxations)."""
    n = len(units)
    if k < 1 or k > n:
        raise ValueError('per_session=%d 은 1 이상, 단위 수(%d) 이하여야 합니다' % (k, n))
    pi = {p: i for i, p in enumerate(patients)}
    mi = {m: i for i, m in enumerate(models)}
    M = max(len(models), 1)
    order = sorted(units, key=lambda u: ((mi[split_key(u)[1]] - pi[split_key(u)[0]]) % M, pi[split_key(u)[0]], mi[split_key(u)[1]]))
    r = k // math.gcd(n, k)
    n_p = len(set(split_key(u)[0] for u in units))
    n_m = len(set(split_key(u)[1] for u in units))
    cap_p0, cap_m0 = -(-k // n_p), -(-k // n_m)
    notes = []
    tries = [(cap_p0, cap_m0)]
    for extra in range(1, k + 1):
        tries += [(cap_p0, cap_m0 + extra), (cap_p0 + extra, cap_m0), (cap_p0 + extra, cap_m0 + extra)]
    for cap_p, cap_m in tries:
        blocks = _search(order, k, r, min(cap_p, k), min(cap_m, k), 200000)
        if blocks:
            if (cap_p, cap_m) != (cap_p0, cap_m0):
                notes.append('한 묶음 안에서 같은 환자 최대 %d건, 같은 모델 최대 %d건으로 완화했습니다 (relaxed distinctness)' % (cap_p, cap_m))
            if r > 1:
                notes.append('단위 %d개를 %d개씩 묶느라 각 단위가 %d번씩 나옵니다 (each unit appears %d times)' % (n, k, r, r))
            break
    else:
        raise ValueError('묶음을 만들 수 없습니다 (units=%d, per_session=%d)' % (n, k))
    base = [sorted(b, key=lambda u: (mi[split_key(u)[1]], pi[split_key(u)[0]])) for b in blocks]
    return base, notes


def sequences_of(block):
    return [[block[i] for i in row] for row in williams(len(block))]


def auto_groups(units, patients, models, k, label_word):
    blocks, notes = make_blocks(units, patients, models, k)
    out = []
    for i, b in enumerate(blocks):
        gid = letters(i)
        out.append({'id': gid, 'label': {'ko': '%s %s' % (label_word, gid), 'en': '%s %s' % (label_word, gid)},
                    'sequences': sequences_of(b)})
    return out, notes


def gc_minutes(n_items, per_item):
    m = n_items * per_item
    lo = int(math.floor(m / 5.0 + 1e-9)) * 5
    if m <= 5:
        lo = 5
    return [lo, lo + 5]


def balance_report(groups):
    """{unit: count over the groups' first sequences} — every unit should appear equally often."""
    cnt = {}
    for g in groups:
        for u in g['sequences'][0]:
            cnt[u] = cnt.get(u, 0) + 1
    return cnt
