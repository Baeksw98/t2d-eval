"""Input checks run before anything is written (messages: Korean first, an English code in brackets)."""
import re

from .common import PATIENT_RE, SET_ID_RE, rel

STATUSES = ('draft', 'frozen', 'retired')
GROUP_ID_RE = re.compile(r'^[A-Za-z0-9]{1,8}$')


def manifest(m, path, models, problems):
    """Normalise a set manifest (cases/sets/<id>.json). Returns the normalised dict or None."""
    where = rel(path)
    if not isinstance(m, dict):
        problems.error(where, '세트 매니페스트는 JSON 객체여야 합니다 [bad-manifest]')
        return None
    sid = m.get('id')
    stem = path.stem
    if not isinstance(sid, str) or not SET_ID_RE.match(sid):
        problems.error(where, '"id" 는 영문·숫자로 시작하는 40자 이하 이름이어야 합니다 (예: v2) — 받은 값 %r [bad-set-id]' % (sid,))
        return None
    if sid != stem:
        problems.error(where, '"id" (%s) 와 파일 이름 (%s.json) 이 다릅니다 [set-id-filename]' % (sid, stem), '파일 이름을 <id>.json 으로 맞추세요')
    out = {'id': sid, 'path': path, 'where': where}
    st = m.get('status', 'draft')
    if st not in STATUSES:
        problems.error(where, '"status" 는 %s 중 하나여야 합니다 — 받은 값 %r [bad-status]' % (' / '.join(STATUSES), st))
    out['status'] = st
    t = m.get('title') or {}
    if isinstance(t, str):
        t = {'ko': t, 'en': t}
    out['title'] = {'ko': str(t.get('ko') or ('케이스 세트 ' + sid)), 'en': str(t.get('en') or t.get('ko') or ('Case set ' + sid))}

    pats = m.get('patients')
    if not isinstance(pats, list) or not pats:
        problems.error(where, '"patients" 에 환자 ID 목록이 필요합니다 (예: ["P051", "P011"]) [no-patients]')
        pats = []
    bad = [p for p in pats if not isinstance(p, str) or not re.match('^%s$' % PATIENT_RE, p)]
    if bad:
        problems.error(where, '환자 ID 형식이 아닙니다: %s [bad-patient-id]' % ', '.join(map(repr, bad)), '형식: P 다음 숫자 3–4자리 (예: P051)')
    dup = sorted(set(p for p in pats if pats.count(p) > 1))
    if dup:
        problems.error(where, '환자가 두 번 있습니다: %s [duplicate-patient]' % ', '.join(dup))
    out['patients'] = [p for i, p in enumerate(pats) if isinstance(p, str) and p not in pats[:i]]

    mods = m.get('models')
    if not isinstance(mods, list) or not mods:
        problems.error(where, '"models" 에 모델 code 목록이 필요합니다 (예: ["deepseek", "gpt"]) [no-models]')
        mods = []
    unknown = [x for x in mods if x not in models.by_code]
    for x in unknown:
        code = models.code_of(x) if isinstance(x, str) else None
        if code:   # a name or alias of a known model: say which code to write (adding it again would be a duplicate alias)
            problems.error(where, '"%s" 은(는) 모델 %s 의 이름(별칭)입니다 — "models" 에는 code "%s" 를 쓰세요 [unknown-model]' % (x, code, code),
                           '"models": [%s]' % ', '.join('"%s"' % (models.code_of(y) or y) if isinstance(y, str) else repr(y) for y in mods))
        else:
            problems.error(where, 'cases/models.json 에 없는 모델 code: %r [unknown-model]' % (x,),
                           'cases/models.json 에 모델을 추가하세요 (code·name·aliases). 등록된 code: %s' % ', '.join(sorted(models.by_code)))
    dupm = sorted(set(x for x in mods if mods.count(x) > 1))
    if dupm:
        problems.error(where, '모델이 두 번 있습니다: %s [duplicate-model]' % ', '.join(dupm))
    out['models'] = [x for i, x in enumerate(mods) if x in models.by_code and x not in mods[:i]]
    out['units'] = ['%s_%s' % (p, x) for p in out['patients'] for x in out['models']]

    src = m.get('sources') or {}
    out['sources'] = {}
    for kind in ('ca', 'gc'):
        v = src.get(kind, ['%s/**/*.md' % kind])
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
            problems.error(where, '"sources.%s" 는 cases/sources/ 아래 파일 경로(또는 glob) 목록이어야 합니다 [bad-sources]' % kind)
            v = []
        out['sources'][kind] = v

    dv = m.get('data_version') or {}
    if isinstance(dv, str):
        dv = {'ca': dv, 'gc': dv}
    out['data_version'] = {k: (str(dv[k]) if dv.get(k) else None) for k in ('ca', 'gc')}

    ca = m.get('ca') or {}
    if not isinstance(ca, dict):
        problems.error(where, '"ca" 는 객체여야 합니다 [bad-ca]')
        ca = {}
    out['ca'] = {
        'per_session': _int(ca.get('per_session', 2), where, 'ca.per_session', problems),
        'minutes_per_unit': _range(ca.get('minutes_per_unit', [10, 15]), where, 'ca.minutes_per_unit', problems),
        'types': ca.get('types', 'auto'),
    }
    gc = m.get('gc', {})
    if gc is False or gc is None:
        out['gc'] = None
    else:
        if not isinstance(gc, dict):
            problems.error(where, '"gc" 는 객체 또는 false 여야 합니다 [bad-gc]')
            gc = {}
        mpi = gc.get('minutes_per_item', 1.2)
        if not isinstance(mpi, (int, float)) or mpi <= 0:
            problems.error(where, '"gc.minutes_per_item" 은 양수여야 합니다 [bad-minutes]')
            mpi = 1.2
        out['gc'] = {
            'per_session': _int(gc.get('per_session', out['ca']['per_session']), where, 'gc.per_session', problems),
            'minutes_per_item': mpi,
            'parts': gc.get('parts', 'auto'),
        }
    for k, v in (('ca', out['ca']), ('gc', out['gc'])):
        if v and out['units'] and v['per_session'] > len(out['units']):
            problems.error(where, '%s.per_session (%d) 이 단위 수 (환자 %d × 모델 %d = %d) 보다 큽니다 [per-session]' %
                           (k, v['per_session'], len(out['patients']), len(out['models']), len(out['units'])))
    return out


def _int(v, where, name, problems):
    if not isinstance(v, int) or isinstance(v, bool) or v < 1:
        problems.error(where, '"%s" 는 1 이상의 정수여야 합니다 — 받은 값 %r [bad-number]' % (name, v))
        return 2
    return v


def _range(v, where, name, problems):
    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) and x > 0 for x in v) and v[1] >= v[0]):
        problems.error(where, '"%s" 는 [최소, 최대] 분이어야 합니다 (예: [10, 15]) [bad-range]' % name)
        return [10, 15]
    return v


def groups(gs, unit_keys, word, where, problems):
    """Check explicit Types/Parts ([{id, sequences, label?}]). Returns the normalised list (labels filled in)."""
    if not isinstance(gs, list) or not gs:
        problems.error(where, '%s 목록이 비어 있습니다 [no-groups]' % word)
        return []
    out, ids = [], set()
    for i, g in enumerate(gs):
        w = '%s %s[%d]' % (where, word, i)
        if not isinstance(g, dict):
            problems.error(w, '객체여야 합니다 [bad-group]')
            continue
        gid = g.get('id')
        if not isinstance(gid, str) or not GROUP_ID_RE.match(gid):
            problems.error(w, 'id 는 영문·숫자 1–8자여야 합니다 (예: A) — 받은 값 %r [bad-group-id]' % (gid,))
            continue
        if gid in ids:
            problems.error(w, 'id "%s" 가 두 번 있습니다 [duplicate-group]' % gid)
            continue
        ids.add(gid)
        seqs = g.get('sequences')
        if not isinstance(seqs, list) or not seqs or not all(isinstance(s, list) and s for s in seqs):
            problems.error(w, 'sequences 는 unit 키 목록들의 목록이어야 합니다 [bad-sequences]')
            continue
        unknown = sorted(set(k for s in seqs for k in s if k not in unit_keys))
        if unknown:
            problems.error(w, '이 세트에 없는 unit: %s [unknown-unit]' % ', '.join(map(str, unknown)),
                           'unit 키 = 환자_모델 (예: P051_gpt), 세트의 patients × models 안에서만')
        first = sorted(seqs[0])
        if any(sorted(s) != first for s in seqs) or len(set(seqs[0])) != len(seqs[0]):
            problems.error(w, '모든 sequence 는 같은 unit 들의 순서만 다른 배열이어야 하고 중복이 없어야 합니다 [bad-sequences]')
        lab = g.get('label') or '%s %s' % (word, gid)
        if isinstance(lab, str):
            lab = {'ko': lab, 'en': lab}
        out.append({'id': gid, 'label': {'ko': lab.get('ko') or '%s %s' % (word, gid), 'en': lab.get('en') or lab.get('ko') or '%s %s' % (word, gid)},
                    'sequences': seqs})
    cnt = {}
    for g in out:
        for k in g['sequences'][0]:
            cnt[k] = cnt.get(k, 0) + 1
    missing = [k for k in unit_keys if k not in cnt]
    if missing:
        problems.warn(where, '%s 에 들어가지 않은 unit: %s [unit-not-assigned]' % (word, ', '.join(missing)))
    if len(set(cnt.values())) > 1:
        problems.warn(where, '%s 마다 unit 이 나오는 횟수가 다릅니다: %s [unbalanced]' % (word, ', '.join('%s×%d' % kv for kv in sorted(cnt.items()))))
    return out
