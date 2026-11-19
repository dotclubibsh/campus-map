# Builds the realistic shell of the IBS academic block for the 3D view.
#
#   python tools/build_campus_shell.py            writes the files below
#   python tools/build_campus_shell.py preview    also writes tools/aerial/shell-preview.jpg
#
# The building outlines below were traced by hand on the aerial photo (tools/aerial/campus-aerial.jpg),
# in pixels of the crop this script cuts out. To adjust a shape, run with "preview", open
# shell-preview.jpg, and move the points. Writes:
#   assets/academic-roof.jpg   the aerial photo of the block, drawn on the roofs
#   data/campus-shell.json     outlines, heights, dome, mural and entrance sign, in model units
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AERIAL = os.path.join(ROOT, 'tools', 'aerial')

# The crop, in model units (north is -x, east is -z). Pixel (px, py) in the crop is
# z = Z_MAX - px / ppu and x = X_MIN + py / ppu.
X_MIN, X_MAX, Z_MIN, Z_MAX = 2.59, 8.23, -1.74, 4.84
FLOOR = 0.1   # One storey in model units, about 3.8 m (the room boxes in model.glb use the same)

# kind "block" is a solid building; "pergola" is the open, pillared entrance roof.
# floors is the height in storeys. Points go around the outline in crop pixels.
TRACE = [
    # --- North-west classroom wings ---
    {'id': 'nw-wing-a', 'floors': 3, 'points': [(188, 205), (243, 205), (243, 362), (188, 362)]},
    {'id': 'nw-wing-b', 'floors': 3, 'points': [(343, 198), (397, 198), (397, 352), (343, 352)]},
    {'id': 'nw-hall', 'floors': 3, 'points': [(410, 170), (528, 170), (528, 332), (410, 332)]},
    {'id': 'nw-base', 'floors': 2, 'points': [(188, 362), (430, 362), (430, 440), (188, 440)]},
    {'id': 'n-block', 'floors': 3, 'points': [(535, 193), (640, 193), (640, 302), (535, 302)]},
    {'id': 'n-link', 'floors': 2, 'points': [(430, 332), (585, 332), (585, 380), (520, 380), (520, 445), (430, 445)]},
    # --- North entrance (back) ---
    {'id': 'n-pergola', 'kind': 'pergola', 'floors': 2,
     'points': [(640, 300), (640, 185), (700, 172), (775, 168), (840, 160), (905, 152), (905, 188), (775, 190), (775, 300)]},
    {'id': 'ne-block', 'floors': 3, 'points': [(775, 190), (875, 190), (875, 300), (775, 300)]},
    # --- Courtyard halls ---
    {'id': 'court-hall-n', 'floors': 2, 'points': [(715, 318), (830, 318), (830, 418), (715, 418)]},
    {'id': 'court-hall-s', 'floors': 2, 'points': [(735, 586), (868, 586), (868, 696), (735, 696)]},
    # --- East wing (angled roofs) ---
    {'id': 'east-wing', 'floors': 3,
     'points': [(862, 365), (957, 365), (957, 428), (1062, 428), (1088, 470), (1088, 525), (1062, 584),
                (966, 584), (966, 657), (872, 657), (872, 562), (905, 540), (905, 482), (862, 462)]},
    # --- Central block under the dome ---
    {'id': 'dome-block', 'floors': 4,
     'points': [(382, 445), (482, 445), (522, 470), (526, 602), (496, 642), (385, 642), (350, 612), (347, 482)]},
    # --- South-west wings ---
    {'id': 'sw-base', 'floors': 2, 'points': [(215, 642), (385, 642), (385, 722), (215, 722)]},
    {'id': 'sw-wing-a', 'floors': 3, 'points': [(228, 722), (280, 722), (280, 884), (228, 884)]},
    {'id': 'sw-wing-b', 'floors': 3, 'points': [(385, 722), (435, 722), (435, 872), (385, 872)]},
    {'id': 'sw-hall', 'floors': 3, 'points': [(435, 652), (560, 652), (560, 742), (545, 742), (545, 862), (445, 862), (445, 742), (435, 742)]},
    {'id': 's-block', 'floors': 3, 'points': [(578, 722), (668, 722), (668, 838), (578, 838)]},
    # --- South entrance (front, facing Front Acads Circle) ---
    {'id': 's-pergola', 'kind': 'pergola', 'floors': 2,
     'points': [(668, 712), (808, 712), (808, 822), (950, 815), (952, 838), (880, 848), (808, 842), (740, 838), (700, 852), (668, 838)]},
    {'id': 'se-block', 'floors': 3, 'points': [(800, 745), (915, 745), (915, 820), (800, 820)]},
]

DOME = {'px': (432, 546), 'radius_px': 46, 'floors': 4}
# The IBS mural wall faces the courtyard lawns, on the east side of the central block.
MURAL = {'px': (527, 546), 'facing_px': (1, 0), 'width_px': 66, 'floors_high': 2}
# "The ICFAI Foundation for Higher Education" over the front entrance, facing the circle.
SIGN = {'px': (740, 838), 'facing_px': (0, 1), 'width_px': 130}


def to_model(px, py, ppu):
    return [round(X_MIN + py / ppu, 4), round(Z_MAX - px / ppu, 4)]


def main():
    meta = json.load(open(os.path.join(AERIAL, 'campus-aerial.json')))
    ppu = meta['ppu']
    aerial = Image.open(os.path.join(AERIAL, 'campus-aerial.jpg')).convert('RGB')
    left, top = (meta['zmax'] - Z_MAX) * ppu, (X_MIN - meta['xmin']) * ppu
    right, bottom = (meta['zmax'] - Z_MIN) * ppu, (X_MAX - meta['xmin']) * ppu
    crop = aerial.crop((round(left), round(top), round(right), round(bottom)))
    crop.save(os.path.join(ROOT, 'assets', 'academic-roof.jpg'), quality=82, optimize=True, progressive=True)

    def direction(d):   # A pixel direction as a model direction (x, z)
        return [d[1], -d[0]]

    shell = {
        'roofImage': 'assets/academic-roof.jpg',
        'bounds': {'xMin': X_MIN, 'xMax': X_MAX, 'zMin': Z_MIN, 'zMax': Z_MAX},
        'floorHeight': FLOOR,
        'blocks': [{
            'id': b['id'], 'kind': b.get('kind', 'block'), 'floors': b['floors'],
            'points': [to_model(px, py, ppu) for px, py in b['points']],
        } for b in TRACE],
        'dome': {'center': to_model(*DOME['px'], ppu), 'radius': round(DOME['radius_px'] / ppu, 4), 'floors': DOME['floors']},
        'mural': {'center': to_model(*MURAL['px'], ppu), 'facing': direction(MURAL['facing_px']),
                  'width': round(MURAL['width_px'] / ppu, 4), 'floorsHigh': MURAL['floors_high']},
        'sign': {'center': to_model(*SIGN['px'], ppu), 'facing': direction(SIGN['facing_px']),
                 'width': round(SIGN['width_px'] / ppu, 4)},
    }
    with open(os.path.join(ROOT, 'data', 'campus-shell.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(shell, f, indent=1)
    print(f"Wrote data/campus-shell.json ({len(TRACE)} outlines) and assets/academic-roof.jpg {crop.size}.")

    if len(sys.argv) > 1 and sys.argv[1] == 'preview':
        d = ImageDraw.Draw(crop)
        for b in TRACE:
            colour = (255, 200, 0) if b.get('kind') == 'pergola' else (0, 255, 255)
            d.polygon(b['points'], outline=colour, width=3)
            d.text(b['points'][0], f"{b['id']} ({b['floors']})", fill=(255, 255, 0))
        (cx, cy), r = DOME['px'], DOME['radius_px']
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 0, 0), width=3)
        for mark in (MURAL, SIGN):
            (mx, my), (fx, fy), half = mark['px'], mark['facing_px'], mark['width_px'] / 2
            d.line((mx - fy * half, my - fx * half, mx + fy * half, my + fx * half), fill=(255, 0, 255), width=5)
        crop.save(os.path.join(AERIAL, 'shell-preview.jpg'), quality=80)
        print('Wrote tools/aerial/shell-preview.jpg')


if __name__ == '__main__':
    main()
