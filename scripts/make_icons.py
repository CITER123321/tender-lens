"""Generates the extension icons (public/icons/icon-{16,32,48,128}.png). Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)

TEAL = (15, 118, 110, 255)
WHITE = (255, 255, 255, 255)
AMBER = (251, 191, 36, 255)


def draw(size: int) -> Image.Image:
    s = size * 8  # draw large, then downsample for smooth edges
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s // 5, fill=TEAL)
    # document sheet
    m = s * 0.20
    d.rounded_rectangle([m, s * 0.14, s * 0.66, s * 0.80], radius=s // 22, fill=WHITE)
    for i, y in enumerate((0.30, 0.42, 0.54)):
        d.rounded_rectangle([s * 0.28, s * y, s * (0.58 if i < 2 else 0.48), s * y + s * 0.05], radius=s // 60, fill=TEAL)
    # lens
    cx, cy, r = s * 0.62, s * 0.62, s * 0.19
    w = max(2, int(s * 0.065))
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=AMBER, outline=WHITE, width=w)
    d.line([cx + r * 0.70, cy + r * 0.70, s * 0.90, s * 0.90], fill=WHITE, width=int(w * 1.4))
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    draw(size).save(OUT / f'icon-{size}.png')
    print(f'icons/icon-{size}.png')
