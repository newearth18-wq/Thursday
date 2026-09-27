"""
Makes the SET 13 vision test images: real PNGs with real text and a real QR
code, read by the real OCR (Tesseract) and QR (jsQR) engines in the tests.

    python3 packages/testing/scripts/make-vision-fixtures.py

Needs Pillow and qrcode (`pip install pillow qrcode`) and the Liberation Sans
font. The "password" in form.png is an obviously fake fixture value.
"""
import os
import random

import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'fixtures', 'vision')
FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
BOLD = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def save(image, name):
    image.save(os.path.join(OUT, name), 'PNG', optimize=True)


def form():
    image = Image.new('RGB', (900, 360), 'white')
    draw = ImageDraw.Draw(image)
    draw.text((40, 40), 'Jupiter Vision Test', fill='black', font=font(40, True))
    draw.text((40, 130), 'Invoice total: 42.50 EUR', fill='black', font=font(34))
    draw.text((40, 200), 'Password: river-lantern-42', fill='black', font=font(34))
    draw.rectangle((40, 270, 240, 330), outline='black', width=3)
    draw.text((95, 283), 'Submit', fill='black', font=font(28))
    save(image, 'form.png')


def qr():
    code = qrcode.QRCode(border=4, box_size=8)
    code.add_data('https://example.com/jupiter/vision')
    code.make(fit=True)
    save(code.make_image(fill_color='black', back_color='white').convert('RGB'), 'qr.png')


def faint():
    """Text a reader can just make out: Tesseract reads it, but not confidently."""
    random.seed(13)
    image = Image.new('RGB', (600, 120), (200, 200, 200))
    draw = ImageDraw.Draw(image)
    draw.text((20, 40), 'Hello Jupiter', fill=(120, 120, 120), font=font(26))
    pixels = image.load()
    for _ in range(6000):
        x, y = random.randrange(600), random.randrange(120)
        shade = random.randrange(90, 230)
        pixels[x, y] = (shade, shade, shade)
    save(image.filter(ImageFilter.GaussianBlur(0.7)), 'faint.png')


def window(text, name):
    image = Image.new('RGB', (800, 300), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 800, 44), fill=(235, 235, 235))
    draw.text((16, 8), 'Untitled - Notepad', fill='black', font=font(24))
    if text:
        draw.text((20, 80), text, fill='black', font=font(32))
    save(image, name)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    form()
    qr()
    faint()
    window('', 'before.png')
    window('Hello Jupiter', 'after.png')
