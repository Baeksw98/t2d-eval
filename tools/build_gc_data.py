#!/usr/bin/env python3
"""Build gc/data/gc_items.js from the scoring/audit verification markdown (4 reports).

Usage: python3 tools/build_gc_data.py <source.md>

Only judgments the AI audit flagged (△ minor / ✗ major) are exported: the AI Rater's other
judgments were confirmed by the audit and are not re-checked by physicians (human-in-the-loop
on the ambiguous part only). The source markdown itself is not committed (it is not needed by
the site and is large); keep it with the scoring run artifacts.
"""
import json, re, sys, datetime

MODEL = {'OpenAI gpt-6.1-sol': 'gpt', 'DeepSeek V4.1 Flash (1017)': 'deepseek'}

def clean(s):
    return s.strip()

def parse(path):
    lines = open(path, encoding='utf-8').read().split('\n')
    units, cur, elem, question = [], None, None, None
    for ln in lines:
        m = re.match(r'^# E11_(P\d{3}) · (.+?) 채점·감사 검증 자료', ln)
        if m:
            cur = {'patient': m.group(1), 'model': MODEL[m.group(2)], 'run': None, 'items': [], 'conc': {}}
            cur['key'] = cur['patient'] + '_' + cur['model']
            units.append(cur); elem = None; question = None
            continue
        if not cur:
            continue
        m = re.match(r'^실행 `([^`]+)`', ln)
        if m and not cur['run']:
            cur['run'] = m.group(1)
        m = re.match(r'^### (\d\.\d) (.+)$', ln)
        if m:
            question = {'id': m.group(1), 'text': m.group(2).strip()}
            continue
        m = re.match(r'^\*\*(1\.\d) (.+)\*\*$', ln)
        if m:
            question = {'id': m.group(1), 'text': m.group(2).strip()}
            continue
        m = re.match(r'^\*\*(Q\d\.\d-\d\d) (.+?)\*\* — 감점 기준: (.+)$', ln)
        if m:
            elem = {'id': m.group(1), 'title': m.group(2).strip(), 'criterion': m.group(3).strip()}
            continue
        m = re.match(r'^\| (조합 (\d)|Phase 1) \| ', ln)
        if m and elem and ln.count(' | ') == 7:
            cells = [c.strip() for c in ln.strip().strip('|').split(' | ')]
            unit_label, verdict, typ, quotes, reason, audit, basis, _phys = cells
            combo = int(m.group(2)) if m.group(2) else 0
            if verdict.startswith('○'):
                v = 'met'
            elif verdict.startswith('−1'):
                v = 'deducted'
            else:
                continue
            corrected = None
            am = re.match(r'^✗ → (충족|감점)', audit)
            if am:
                corrected = 'met' if am.group(1) == '충족' else 'deducted'
            phase = 'P1' if combo == 0 else 'P' + elem['id'][1]
            tkey = cur['key'] + '|' + (phase if combo == 0 else 'C%d|%s' % (combo, phase))
            b = cur['conc'].setdefault(tkey, {'n': 0, 'met_raw': 0, 'met_ai': 0})
            b['n'] += 1
            b['met_raw'] += 1 if v == 'met' else 0
            b['met_ai'] += 1 if (corrected or v) == 'met' else 0
            if not audit or audit[0] not in '△✗':
                continue
            mark = 'major' if audit[0] == '✗' else 'minor'
            body = re.sub(r'^(△|✗ → (충족|감점))\s*', '', audit)
            cm = re.match(r'^\[([^\]]+)\]\s*', body)
            category = cm.group(1) if cm else ''
            if cm:
                body = body[cm.end():]
            # split audit explanation and its 〔evidence〕 quotes
            ev = re.findall(r'〔([^〕]+)〕', body)
            expl = re.sub(r'\s*〔[^〕]+〕', '', body).strip()
            qid = elem['id'][1:4]  # Q2.1-02 -> 2.1
            item_id = '%s|%s|%s' % (cur['key'], ('C%d' % combo) if combo else 'P1', elem['id'])
            cur['items'].append({
                'id': item_id,
                'unit': cur['key'],
                'patient': cur['patient'],
                'combo': combo,
                'question': qid,
                'question_text': question['text'] if question and question['id'] == qid else '',
                'element': elem['id'],
                'title': elem['title'],
                'criterion': elem['criterion'],
                'rater': {
                    'verdict': v,
                    'type': '' if typ in ('', '–') else typ,
                    'quotes': [] if quotes in ('', '–') else re.findall(r'“([^”]*)”(?:\s*\(답안 원문에서 찾지 못함\))?', quotes),
                    'quotes_raw': '' if quotes in ('', '–') else quotes,
                    'reason': reason,
                },
                'audit': {
                    'mark': mark,
                    'corrected': corrected,
                    'category': category,
                    'explanation': expl,
                    'evidence': ev,
                },
                'final': corrected or v,
                'target_key': tkey,
                'basis': basis,
            })
    return units

def main():
    units = parse(sys.argv[1])
    out = {
        'data_version': datetime.date.today().isoformat() + '.gc1',
        'scope': 'AI audit flagged (△/✗) judgments only',
        'units': {},
    }
    for u in units:
        out['units'][u['key']] = {'key': u['key'], 'patient': u['patient'], 'model': u['model'],
                                  'run': u['run'], 'items': u['items'], 'concordance_base': u['conc']}
        def tot(pred, f):
            return sum(v[f] for k, v in u['conc'].items() if pred(k))
        p25 = lambda k: '|C' in k
        print('  P2-5 raw %d/%d  audit %d/%d   P1 %d/%d' % (tot(p25, 'met_raw'), tot(p25, 'n'), tot(p25, 'met_ai'), tot(p25, 'n'),
              tot(lambda k: k.endswith('|P1'), 'met_ai'), tot(lambda k: k.endswith('|P1'), 'n')), file=sys.stderr)
        n = len(u['items']); mj = sum(1 for i in u['items'] if i['audit']['mark'] == 'major')
        print('%-15s %2d items (✗ %d, △ %d)' % (u['key'], n, mj, n - mj), file=sys.stderr)
    js = '/* AUTO-GENERATED by tools/build_gc_data.py — do not edit by hand. */\nwindow.GC_DATA = ' + \
         json.dumps(out, ensure_ascii=False, indent=1) + ';\n'
    open('gc/data/gc_items.js', 'w', encoding='utf-8').write(js)

if __name__ == '__main__':
    main()
