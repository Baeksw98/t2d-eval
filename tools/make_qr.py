"""Generate QR codes (SVG + PNG) for the evaluation links into qr/.
Usage: python3 tools/make_qr.py [base_url] [main|ca|gc|select ...]   (default https://eval.asclep.org, all targets)
  main   -> qr/main.png|svg    처음 화면: 두 평가 중 선택 (통합 QR, 권장)   base/?src=qr
  ca     -> qr/ca.png|svg      임상 수용성 평가 (CA)                      base/ca/?src=qr
  gc     -> qr/gc.png|svg      가이드라인 부합도 검증 (GC)                base/gc/?src=qr
  select -> qr/select.png|svg  예전 CA QR (이미 인쇄·배포됨). main 과 같은 주소(base/?src=qr)이며 지금은 처음 화면이 열립니다.
                               같은 설정으로 다시 만들면 같은 파일이 나옵니다 (인쇄본과 같은 QR).
Prints each target's payload and QR version; decode the PNGs to double-check (see README, 'QR 코드')."""
import sys, qrcode, qrcode.image.svg
from qrcode.constants import ERROR_CORRECT_Q

args = sys.argv[1:]
base = (args.pop(0) if args and '://' in args[0] else 'https://eval.asclep.org').rstrip('/')
targets = {
    'main': base + '/?src=qr',       # 처음 화면 (랜딩): GC·CA 중 선택. src·site·wave 는 랜딩이 각 평가 링크에 넘김
    'ca': base + '/ca/?src=qr',      # CA: Type A·B 는 시작 화면에서 선택
    'gc': base + '/gc/?src=qr',      # GC: Part A·B 는 시작 화면에서 선택
    'select': base + '/?src=qr',     # 예전 CA QR (인쇄됨) = main 과 같은 주소
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
    print(name, url, 'version', make().version)
