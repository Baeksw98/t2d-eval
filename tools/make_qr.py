"""Generate QR codes (SVG + PNG) for the evaluation links into qr/.
Usage: python3 tools/make_qr.py [base_url] [select|gc ...]   (default https://eval.asclep.org, all targets)
  select -> qr/select.png|svg  임상 수용성 평가 (CA)          base/?src=qr
  gc     -> qr/gc.png|svg      가이드라인 부합도 검증 (GC)    base/gc/?src=qr"""
import sys, qrcode, qrcode.image.svg
from qrcode.constants import ERROR_CORRECT_Q

args = sys.argv[1:]
base = (args.pop(0) if args and '://' in args[0] else 'https://eval.asclep.org').rstrip('/')
targets = {
    'select': base + '/?src=qr',     # CA: QR 은 하나로 통일 (Type 은 시작 화면에서 선택)
    'gc': base + '/gc/?src=qr',      # GC: Part A·B 는 시작 화면에서 선택
}
unknown = [a for a in args if a not in targets]
if unknown:
    sys.exit('unknown target(s): ' + ', '.join(unknown) + ' (choose from ' + ', '.join(targets) + ')')
for name, url in targets.items():
    if args and name not in args:
        continue
    def make():
        q = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=20, border=4)
        q.add_data(url); q.make(fit=True); return q
    make().make_image(fill_color='#14304a', back_color='white').save(f'qr/{name}.png')
    make().make_image(image_factory=qrcode.image.svg.SvgPathImage).save(f'qr/{name}.svg')
    print(name, url, make().version)
