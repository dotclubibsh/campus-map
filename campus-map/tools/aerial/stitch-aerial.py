# Stitches the tiles from extract-tiles.cjs into campus-aerial.jpg, north up.
# In model units north is -x and east is -z; campus-aerial.json records the scale and origin
# so build_share_pages.py can find any place on the photo.
#
#   python tools/aerial/stitch-aerial.py
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TILES = os.path.join(HERE, 'tiles')
PPU = 190   # Pixels per model unit, about 5 px per metre
tiles = json.load(open(os.path.join(TILES, 'tiles.json')))
xs = [p['x'] for t in tiles for p in t['points']]; zs = [p['z'] for t in tiles for p in t['points']]
xmin, xmax, zmin, zmax = max(min(xs), -13.5), min(max(xs), 13.5), max(min(zs), -13.5), min(max(zs), 13.5)
W, H = round((zmax - zmin) * PPU), round((xmax - xmin) * PPU)
to_px = lambda x, z: ((zmax - z) * PPU, (x - xmin) * PPU)
out = Image.new('RGB', (W, H), (18, 19, 24))
for t in tiles:
    img = Image.open(os.path.join(TILES, t['file'])).convert('RGB'); sw, sh = img.size
    pts = t['points']
    # Affine from output pixel to source pixel, solved from three corners.
    A = []; bx = []; by = []
    for p in pts[:3]:
        px, py = to_px(p['x'], p['z']); A.append([px, py, 1]); bx.append(p['u'] * sw); by.append(p['v'] * sh)
    a = np.linalg.solve(np.array(A), np.array(bx)); b = np.linalg.solve(np.array(A), np.array(by))
    tx = [to_px(p['x'], p['z'])[0] for p in pts]; ty = [to_px(p['x'], p['z'])[1] for p in pts]
    x0, y0, x1, y1 = max(0, int(min(tx))), max(0, int(min(ty))), min(W, int(max(tx)) + 1), min(H, int(max(ty)) + 1)
    if x1 <= x0 or y1 <= y0: continue
    # Shift the affine to the crop origin.
    coeffs = (a[0], a[1], a[0] * x0 + a[1] * y0 + a[2], b[0], b[1], b[0] * x0 + b[1] * y0 + b[2])
    part = img.transform((x1 - x0, y1 - y0), Image.AFFINE, coeffs, resample=Image.BICUBIC)
    mask = Image.new('L', (sw, sh), 255).transform((x1 - x0, y1 - y0), Image.AFFINE, coeffs, resample=Image.NEAREST)
    out.paste(part, (x0, y0), mask)
out.save(os.path.join(HERE, 'campus-aerial.jpg'), quality=80, optimize=True, progressive=True)
json.dump({'ppu': PPU, 'xmin': xmin, 'zmax': zmax, 'width': W, 'height': H}, open(os.path.join(HERE, 'campus-aerial.json'), 'w'), indent=1)
print(W, H)
