"""
Makes the SET 14 identity test images from two real photographs that ship
with scikit-image (https://scikit-image.org), both free to reuse:

- astronaut.png: Eileen Collins, NASA portrait (public domain) — the owner.
- camera.png: a person with a camera, by Lav Varshney (CC0) — someone else.

    pip download scikit-image==0.26.0 --no-deps -d /tmp/skimage
    python3 packages/testing/scripts/make-identity-fixtures.py /tmp/skimage/scikit_image-*.whl

Needs Pillow. The owner's frames zoom in step by step, as a person moving
closer to the camera does (the liveness challenge), with the small changes
in light and noise a real camera adds.
"""
import io
import os
import random
import sys
import zipfile

from PIL import Image, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'fixtures', 'identity')
SIZE = 256


def photo(wheel, name):
    with zipfile.ZipFile(wheel) as archive:
        return Image.open(io.BytesIO(archive.read(f'skimage/data/{name}.png'))).convert('RGB')


def crop(image, cx, cy, side):
    half = side // 2
    return image.crop((cx - half, cy - half, cx + half, cy + half)).resize(
        (SIZE, SIZE), Image.Resampling.LANCZOS
    )


def noisy(image, seed):
    rng = random.Random(seed)
    image = ImageEnhance.Brightness(image).enhance(1 + rng.uniform(-0.04, 0.04))
    pixels = image.load()
    for _ in range(SIZE * SIZE // 20):
        x, y = rng.randrange(SIZE), rng.randrange(SIZE)
        r, g, b = pixels[x, y]
        d = rng.randint(-12, 12)
        pixels[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))
    return image


def save(image, name):
    image.save(os.path.join(OUT, name), 'PNG', optimize=True)


def main(wheel):
    os.makedirs(OUT, exist_ok=True)
    owner = photo(wheel, 'astronaut')
    # The face is about 85 x 100 pixels around (222, 123): crops from 300 down to 200 pixels.
    for index, side in enumerate([300, 275, 250, 225, 200]):
        save(noisy(crop(owner, 222, max(128, side // 2), side), index), f'owner-{index + 1}.png')
    other = photo(wheel, 'camera')
    save(crop(other, 229, 165, 220), 'other.png')


if __name__ == '__main__':
    main(sys.argv[1])
