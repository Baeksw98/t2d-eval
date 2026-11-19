"""Concatenate gas/src/*.gs (core first) into gas/Code.gs — the single file pasted into Apps Script."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent / 'gas'
parts = [root / 'src' / 'core.gs'] + sorted(p for p in (root / 'src').glob('*.gs') if p.name != 'core.gs')
out = '\n'.join(p.read_text(encoding='utf-8').rstrip() + '\n' for p in parts)
(root / 'Code.gs').write_text(out, encoding='utf-8')
print('built gas/Code.gs from', [p.name for p in parts], len(out.splitlines()), 'lines')
