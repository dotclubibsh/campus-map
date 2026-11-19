# Builds a small page and a preview picture for every place, so a shared link shows the place's
# name and an aerial photo with a pin in WhatsApp, Instagram, Telegram and the rest.
#
#   python tools/build_share_pages.py
#
# Run it again whenever data/locations.json changes (tests/site.test.mjs fails until you do).
# Needs Python 3 and Pillow (pip install pillow). Writes:
#   p/<id>/index.html        the link people share; it opens the map on that place
#   assets/share/<id>.jpg    the 1200x630 preview picture
#   assets/share/campus.jpg  the preview for the map itself and for dropped pins
import html
import json
import os
import re
import shutil
import struct

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AERIAL = os.path.join(ROOT, 'tools', 'aerial')
SHARE_IMG_DIR = os.path.join(ROOT, 'assets', 'share')
PAGES_DIR = os.path.join(ROOT, 'p')
W, H = 1200, 630
OUT_PPU = 220              # Zoom of the preview photo, in pixels per model unit (about 170 m across)
PIN_AT = (W // 2, 250)     # Where the place sits in the picture, above the text
SAFE_ID = re.compile(r'^[A-Za-z0-9_-]+$')   # Must match shareLinkFor() in js/app.js

BLUE = (66, 133, 244)
WHITE = (255, 255, 255)
MUTED = (200, 204, 212)


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


def site_url():
    match = re.search(r'<link rel="canonical" href="([^"]+)"', read('index.html'))
    return match.group(1).rstrip('/') + '/'


def font(size, weight='bold'):
    names = {
        'bold': ['segoeuib.ttf', 'Arial Bold.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf', 'Helvetica.ttc'],
        'semibold': ['seguisb.ttf', 'Arial.ttf', 'arial.ttf', 'DejaVuSans.ttf', 'Helvetica.ttc'],
    }[weight]
    folders = ['', 'C:/Windows/Fonts', '/Library/Fonts', '/System/Library/Fonts', '/usr/share/fonts/truetype/dejavu']
    for name in names:
        for folder in folders:
            try:
                return ImageFont.truetype(os.path.join(folder, name), size)
            except OSError:
                continue
    return ImageFont.load_default(size)


# --- WHERE EACH PLACE IS ---
def glb_nodes():
    with open(os.path.join(ROOT, 'assets', 'model.glb'), 'rb') as f:
        data = f.read()
    length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + length])
    return gltf


def three_name(name):
    # three.js renames nodes the same way when it loads the model; locations.json uses those names.
    return re.sub(r'[\[\].:/]', '', re.sub(r'\s', '_', name))


def quat_apply(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    ix, iy, iz = w * vx + y * vz - z * vy, w * vy + z * vx - x * vz, w * vz + x * vy - y * vx
    iw = -x * vx - y * vy - z * vz
    return (ix * w - iw * x - iy * z + iz * y, iy * w - iw * y - iz * x + ix * z, iz * w - iw * z - ix * y + iy * x)


def mesh_boxes(gltf):
    boxes = {}
    for node in gltf['nodes']:
        if 'mesh' not in node:
            continue
        t, r, s = node.get('translation', [0, 0, 0]), node.get('rotation', [0, 0, 0, 1]), node.get('scale', [1, 1, 1])
        xs, zs = [], []
        for prim in gltf['meshes'][node['mesh']]['primitives']:
            acc = gltf['accessors'][prim['attributes']['POSITION']]
            lo, hi = acc['min'], acc['max']
            for cx in (lo[0], hi[0]):
                for cy in (lo[1], hi[1]):
                    for cz in (lo[2], hi[2]):
                        p = quat_apply(r, (cx * s[0], cy * s[1], cz * s[2]))
                        xs.append(p[0] + t[0])
                        zs.append(p[2] + t[2])
        boxes[three_name(node.get('name', ''))] = (min(xs), max(xs), min(zs), max(zs))
    return boxes


def place_point(loc, boxes):
    if loc.get('_assignment_type') == '2d_coords' and loc.get('coordinates'):
        c = loc['coordinates'][0] if isinstance(loc['coordinates'], list) else loc['coordinates']
        return c['x'], c['y']
    names = loc.get('glb_objects') or []
    if isinstance(names, str):   # A single building is stored as a plain name
        names = [names]
    found = [boxes[n] for n in names if n in boxes]
    if not found:
        return None
    return ((min(b[0] for b in found) + max(b[1] for b in found)) / 2,
            (min(b[2] for b in found) + max(b[3] for b in found)) / 2)


# --- TEXT ---
def clean_description(text):
    text = re.sub(r',?\s*Visiting hours:\s*$', '', text or '').strip()
    text = re.sub(r'\s{2,}', ' ', text).replace(' ,', ',')
    return text.replace('Cenral', 'Central')


def subtitle(loc):
    parts = [p for p in (loc.get('cat_lvl_2'), loc.get('cat_lvl_1')) if p]
    unique = []
    for p in parts:
        if p.lower() not in [u.lower() for u in unique]:
            unique.append(p)
    return ' · '.join(unique)


def summary(loc):
    bits = [clean_description(loc.get('description'))]
    near = ' • '.join(n for n in (loc.get('nearby_1'), loc.get('nearby_2')) if n)
    if near:
        bits.append(near)
    bits.append('Open in Campus Connect, the IFHE campus map, for walking directions.')
    return '. '.join(b.rstrip('.') for b in bits if b) + '.'


def fit_lines(draw, text, fnt_for, max_width, max_lines=2, start=72, smallest=44):
    for size in range(start, smallest - 1, -4):
        fnt = fnt_for(size)
        words, lines, line = text.split(), [], ''
        for word in words:
            trial = f'{line} {word}'.strip()
            if draw.textlength(trial, font=fnt) <= max_width:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
        if len(lines) <= max_lines and all(draw.textlength(l, font=fnt) <= max_width for l in lines):
            return fnt, lines
    fnt = fnt_for(smallest)
    return fnt, [text]


# --- PICTURES ---
def pin_image(height=96):
    # Drawn four times larger and shrunk, for smooth edges.
    k = 4
    w, h = int(height * 0.78) * k, height * k
    img = Image.new('RGBA', (w, h + 12 * k), (0, 0, 0, 0))
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse((w * 0.25, h - 4 * k, w * 0.75, h + 10 * k), fill=(0, 0, 0, 140))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(4 * k)))
    d = ImageDraw.Draw(img)
    r = w / 2
    d.ellipse((0, 0, w, w), fill=WHITE)
    d.polygon([(w * 0.14, r * 1.45), (w * 0.86, r * 1.45), (r, h)], fill=WHITE)
    inset = 5 * k
    d.ellipse((inset, inset, w - inset, w - inset), fill=BLUE)
    d.polygon([(w * 0.14 + inset, r * 1.42), (w * 0.86 - inset, r * 1.42), (r, h - inset * 1.6)], fill=BLUE)
    d.ellipse((r - w * 0.17, r - w * 0.17, r + w * 0.17, r + w * 0.17), fill=WHITE)
    return img.resize((img.width // k, img.height // k), Image.LANCZOS)


def rounded_chip(base, xy, text, fnt, fill, color, logo=None, pad=(22, 12)):
    d = ImageDraw.Draw(base)
    x, y = xy
    tw = d.textlength(text, font=fnt)
    asc, desc = fnt.getmetrics()
    logo_w = 0
    if logo is not None:
        logo_w = logo.width + 12
    box = (x, y, x + pad[0] * 2 + logo_w + tw, y + pad[1] * 2 + asc + desc)
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box, radius=(box[3] - box[1]) // 2, fill=fill)
    base.alpha_composite(layer)
    if logo is not None:
        base.alpha_composite(logo, (int(x + pad[0]), int(y + (box[3] - box[1] - logo.height) / 2)))
    ImageDraw.Draw(base).text((x + pad[0] + logo_w, y + pad[1]), text, font=fnt, fill=color)
    return box


def bottom_shade(size, start, strength):
    shade = Image.new('L', (1, size[1]), 0)
    for y in range(size[1]):
        t = max(0.0, (y - start) / (size[1] - start))
        shade.putpixel((0, y), int(255 * strength * min(1.0, t) ** 1.2))
    return shade.resize(size)


def crop_photo(aerial, meta, px, py, ppu_out):
    scale = meta['ppu'] / ppu_out
    cw, ch = W * scale, H * scale
    left = px - PIN_AT[0] * scale
    top = py - PIN_AT[1] * scale
    left = min(max(left, 0), aerial.width - cw)
    top = min(max(top, 0), aerial.height - ch)
    photo = aerial.crop((int(left), int(top), int(left + cw), int(top + ch))).resize((W, H), Image.LANCZOS)
    return photo.convert('RGBA'), ((px - left) / scale, (py - top) / scale)


def make_card(photo, pin_xy, title, sub, logo, pin):
    card = photo
    dark = Image.new('RGBA', (W, H), (12, 13, 18, 255))
    card = Image.composite(dark, card, bottom_shade((W, H), 300, 0.92))   # Keeps the name readable

    if pin_xy is not None:
        ring = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        rx, ry = pin_xy
        ImageDraw.Draw(ring).ellipse((rx - 46, ry - 15, rx + 46, ry + 15), fill=(66, 133, 244, 90), outline=(138, 180, 248, 230), width=3)
        card.alpha_composite(ring)
        card.alpha_composite(pin, (int(rx - pin.width / 2), int(ry - pin.height + 8)))

    d = ImageDraw.Draw(card)
    rounded_chip(card, (40, 36), 'Campus Connect · IFHE Hyderabad', font(26, 'semibold'), (18, 19, 24, 200), WHITE, logo)

    fnt, lines = fit_lines(d, title, lambda s: font(s, 'bold'), W - 80)
    asc, desc = fnt.getmetrics()
    line_h = asc + desc
    sub_font = font(30, 'semibold')
    y = H - 56 - (34 if sub else 0) - line_h * len(lines)
    for line in lines:
        d.text((40, y), line, font=fnt, fill=WHITE)
        y += line_h
    if sub:
        d.text((42, y + 4), sub, font=sub_font, fill=MUTED)

    cta = font(26, 'bold')
    label = 'Walking directions'
    tw = d.textlength(label, font=cta)
    rounded_chip(card, (W - 40 - tw - 44, 36), label, cta, (66, 133, 244, 255), WHITE)
    return card.convert('RGB')


# --- PAGES ---
def page_html(base, loc_id, title, description, image_name, alt):
    t, desc, a = html.escape(title), html.escape(description), html.escape(alt)
    page_url = f'{base}p/{loc_id}/'
    image_url = f'{base}assets/share/{image_name}'
    target = f'../../?place={loc_id}'
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta http-equiv="refresh" content="0; url={target}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="theme-color" content="#121318">
<title>{t} · Campus Connect</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{page_url}">
<link rel="icon" type="image/png" sizes="32x32" href="../../assets/favicon-32.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Campus Connect">
<meta property="og:title" content="{t}">
<meta property="og:description" content="{desc}">
<meta property="og:url" content="{page_url}">
<meta property="og:image" content="{image_url}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="{W}">
<meta property="og:image:height" content="{H}">
<meta property="og:image:alt" content="{a}">
<meta name="twitter:card" content="summary_large_image">
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #121318; color: #e8eaed; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
  a {{ color: #8ab4f8; }}
</style>
</head>
<body>
  <p>Opening {t} in Campus Connect. <a href="{target}">Open it now</a></p>
</body>
</html>
'''


def main():
    base = site_url()
    locations = json.loads(read('data/locations.json'))
    meta = json.loads(read('tools/aerial/campus-aerial.json'))
    aerial = Image.open(os.path.join(AERIAL, 'campus-aerial.jpg')).convert('RGB')
    boxes = mesh_boxes(glb_nodes())
    # The Campus Connect mark (tools/make_icons.py), next to the name in the corner chip.
    logo = Image.open(os.path.join(ROOT, 'assets', 'brand-mark-64.png')).convert('RGBA')
    logo = logo.resize((36, 36), Image.LANCZOS)
    pin = pin_image()

    # Start clean so pages for deleted places don't linger.
    shutil.rmtree(PAGES_DIR, ignore_errors=True)
    shutil.rmtree(SHARE_IMG_DIR, ignore_errors=True)
    os.makedirs(SHARE_IMG_DIR)

    # The whole campus: used by the map's own link and by dropped-pin links.
    overview_ppu = W / ((meta['width'] / meta['ppu']) * 0.92)
    photo, _ = crop_photo(aerial, meta, meta['width'] / 2, meta['height'] * 0.52, overview_ppu)
    make_card(photo, None, 'IFHE Hyderabad campus map', 'Find any classroom, hostel or office and walk there', logo, pin) \
        .save(os.path.join(SHARE_IMG_DIR, 'campus.jpg'), quality=62, optimize=True, progressive=True)

    built, skipped = 0, []
    for loc in locations:
        if loc.get('system_data') or loc.get('is_category_node') or not loc.get('display_name'):
            continue
        if not SAFE_ID.match(loc['id']):
            skipped.append(loc['id'])
            continue
        point = place_point(loc, boxes)
        title = loc['display_name'].strip()
        sub = subtitle(loc)
        if point:
            px, py = (meta['zmax'] - point[1]) * meta['ppu'], (point[0] - meta['xmin']) * meta['ppu']
            photo, pin_xy = crop_photo(aerial, meta, px, py, OUT_PPU)
        else:   # No position on the map yet: show the campus without a pin
            photo, _ = crop_photo(aerial, meta, meta['width'] / 2, meta['height'] / 2, OUT_PPU)
            pin_xy = None
        image_name = f"{loc['id']}.jpg"
        make_card(photo, pin_xy, title, sub, logo, pin) \
            .save(os.path.join(SHARE_IMG_DIR, image_name), quality=62, optimize=True, progressive=True)

        os.makedirs(os.path.join(PAGES_DIR, loc['id']))
        alt = f'Aerial photo of the IFHE campus with a pin on {title}'
        with open(os.path.join(PAGES_DIR, loc['id'], 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(page_html(base, loc['id'], title, summary(loc), image_name, alt))
        built += 1

    print(f'Built {built} share pages in p/ and pictures in assets/share/.')
    if skipped:
        print('Skipped ids with characters a link cannot hold:', ', '.join(skipped))


if __name__ == '__main__':
    main()
