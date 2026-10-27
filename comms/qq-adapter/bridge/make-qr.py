import sys
import qrcode

url = sys.argv[1]
out = sys.argv[2]
qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=12,
    border=4,
)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color="black", back_color="white")
img.save(out)
print("saved", out, "version", qr.version)
