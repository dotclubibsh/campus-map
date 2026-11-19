# Draws the Campus Connect mark (a blue pin at the end of a dotted walking route) and writes
# the app icons, the favicon and the small mark used on link previews.
#
#   python tools/make_icons.py
#
# The same shapes are inlined as SVG in index.html (.cc-mark); keep the two in step.
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
S = 2048                      # Drawn large, then shrunk for smooth edges
BG_TOP, BG_BOTTOM = (34, 38, 52), (18, 19, 24)
BLUE, BLUE_DARK, ROUTE, WHITE = (66, 133, 244), (26, 115, 232), (138, 180, 248), (255, 255, 255)


def background(full_bleed):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (1, S))
    for y in range(S):
        t = y / (S - 1)
        grad.putpixel((0, y), tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3)) + (255,))
    grad = grad.resize((S, S))
    if full_bleed:
        return grad
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return tuple(u ** 3 * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t ** 3 * p3[i] for i in range(2))


def draw_mark(img, scale=1.0, route=True):
    d = ImageDraw.Draw(img)
    k = S * scale
    off = S * (1 - scale) / 2
    P = lambda x, y: (off + x * k, off + y * k)

    if route:
        # Dotted walking route from a start point (bottom left) to the pin's tip.
        start, tip = P(0.2, 0.82), P(0.6, 0.79)
        c1, c2 = P(0.2, 0.58), P(0.62, 0.98)
        for i in range(1, 8):   # Evenly spaced dots, stopping short of the pin
            x, y = bezier(start, c1, c2, tip, i / 9)
            r = k * 0.027
            d.ellipse((x - r, y - r, x + r, y + r), fill=ROUTE)
        r = k * 0.055
        sx, sy = start
        d.ellipse((sx - r, sy - r, sx + r, sy + r), fill=WHITE)
        r2 = k * 0.03
        d.ellipse((sx - r2, sy - r2, sx + r2, sy + r2), fill=BLUE_DARK)

    # The pin: a circle with a point, a white dot in the middle.
    cx, cy, R = (0.6, 0.4, 0.22) if route else (0.5, 0.4, 0.28)
    tip_y = cy + R * 1.78
    (x0, y0), (x1, y1) = P(cx - R, cy - R), P(cx + R, cy + R)
    d.ellipse((x0, y0, x1, y1), fill=BLUE)
    d.polygon([P(cx - R * 0.83, cy + R * 0.55), P(cx + R * 0.83, cy + R * 0.55), P(cx, tip_y)], fill=BLUE)
    ir = R * 0.42
    (a0, b0), (a1, b1) = P(cx - ir, cy - ir), P(cx + ir, cy + ir)
    d = ImageDraw.Draw(img)
    d.ellipse((a0, b0, a1, b1), fill=WHITE)
    return img


def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(ASSETS, name), optimize=True)


def main():
    icon = draw_mark(background(full_bleed=False), 0.86)
    save(icon, 'icon-192.png', 192)
    save(icon, 'icon-512.png', 512)
    # Maskable icons get cropped to a circle or squircle, so keep the mark inside the middle 80%.
    save(draw_mark(background(full_bleed=True), 0.68), 'icon-maskable-512.png', 512)
    save(draw_mark(background(full_bleed=True), 0.8), 'apple-touch-icon.png', 180)
    # At 32 px the route turns to mush; the favicon is just the pin.
    save(draw_mark(background(full_bleed=False), 1.0, route=False), 'favicon-32.png', 32)
    # For the corner of link previews: the mark on its own, no background.
    mark = draw_mark(Image.new('RGBA', (S, S), (0, 0, 0, 0)), 1.0)
    save(mark, 'brand-mark-64.png', 64)
    print('Icons written to assets/.')


if __name__ == '__main__':
    main()
