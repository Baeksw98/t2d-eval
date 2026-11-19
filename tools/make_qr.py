"""Generate QR codes (SVG + PNG) for the evaluation links into qr/.
Usage: python3 tools/make_qr.py [base_url]   (default https://eval.asclep.org)"""
import sys, qrcode, qrcode.image.svg
from qrcode.constants import ERROR_CORRECT_Q

base = (sys.argv[1] if len(sys.argv) > 1 else 'https://eval.asclep.org').rstrip('/')
targets = {'select': base + '/?src=qr'}   # QR 은 하나로 통일 (Type 은 시작 화면에서 선택)
for name, url in targets.items():
    def make():
        q = qrcode.QRCode(error_correction=ERROR_CORRECT_Q, box_size=20, border=4)
        q.add_data(url); q.make(fit=True); return q
    make().make_image(fill_color='#14304a', back_color='white').save(f'qr/{name}.png')
    make().make_image(image_factory=qrcode.image.svg.SvgPathImage).save(f'qr/{name}.svg')
    print(name, url, make().version)
