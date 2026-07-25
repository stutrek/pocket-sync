#!/usr/bin/env python3
"""Generate the tray and app icons (run once; outputs live in assets/).

Usage: "$XTEINK_VENV/bin/python3" scripts/make_icons.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)


def reader_glyph(size, fg, bg=None, pad_ratio=0.10):
    """An e-reader outline with three text lines."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if bg is not None:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=bg)

    pad = int(size * pad_ratio)
    w = size - pad * 2
    body = [pad + int(w * 0.10), pad, pad + int(w * 0.90), size - pad]
    stroke = max(2, int(size * 0.055))
    d.rounded_rectangle(body, radius=int(size * 0.10), outline=fg, width=stroke)

    # screen lines, centred in the screen area
    x0 = body[0] + stroke * 2
    x1 = body[2] - stroke * 2
    gap = stroke * 2.2
    block = stroke * 3 + gap * 2
    top = body[1] + (body[3] - body[1] - block) / 2.0
    for i in range(3):
        y = top + (stroke + gap) * i
        end = x1 if i < 2 else x0 + (x1 - x0) * 0.55
        d.rounded_rectangle([x0, y, end, y + stroke], radius=stroke // 2, fill=fg)
    return img


def main():
    black = (0, 0, 0, 255)
    white = (255, 255, 255, 255)

    # Menu-bar icons: macOS renders these small; draw at 2x for retina.
    reader_glyph(44, black).save(os.path.join(ASSETS, "tray.png"))
    reader_glyph(44, white).save(os.path.join(ASSETS, "tray-dark.png"))

    # App icon: light glyph on a dark rounded square.
    app = reader_glyph(512, (245, 245, 247, 255), bg=(31, 31, 36, 255), pad_ratio=0.20)
    app.save(os.path.join(ASSETS, "icon.png"))
    # Windows wants a multi-resolution .ico.
    app.save(os.path.join(ASSETS, "icon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    print("wrote tray.png, tray-dark.png, icon.png, icon.ico to %s" % ASSETS)


if __name__ == "__main__":
    main()
