"""
Genera una hoja de contacto con todas las variantes de realce.

El objetivo es puramente visual: ver de un vistazo cual de los metodos vuelve
legible el grabado en relieve, antes de invertir tiempo en el motor de OCR.
Si ninguna columna lo resuelve, el problema esta en la captura, no en el
software.

    python src/contact_sheet.py input/foto.jpg
"""

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import enhance as E


TILE_W = 520


def label(img, text):
    """Convierte a BGR y le pega una franja con el nombre de la variante."""
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    img = cv2.resize(img, (TILE_W, int(h * TILE_W / w)), interpolation=cv2.INTER_AREA)
    bar = np.full((34, TILE_W, 3), 30, np.uint8)
    cv2.putText(bar, text, (8, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return np.vstack([bar, img])


def variants(gray):
    flat = E.flatten_illumination(gray, sigma=51)
    out = [
        ("00 original", gray),
        ("01 illum flattened", flat),
        ("02 clahe", E.clahe(gray)),
        ("03 tinta (pipeline_ink)", E.pipeline_ink(gray)),
        ("04 energia textura w9", E.texture_energy(flat, 9)),
        ("05 energia textura w21", E.texture_energy(flat, 21)),
    ]
    for ang in (0, 45, 90, 135):
        out.append((f"06 direccional {ang} deg", E.directional(flat, ang)))
    for stroke in (9, 15, 25):
        out.append((f"07 morfologia stroke={stroke}", E.morph_relief(flat, stroke)))
    out.append(("08 tinta binarizada", E.denoise_binary(E.binarize(E.pipeline_ink(gray), invert=True))))
    return out


def main(path, cols=4):
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"No se pudo leer la imagen: {path}")
    gray = E.to_gray(img)
    print(f"entrada: {path}  {gray.shape[1]}x{gray.shape[0]}")

    outdir = Path(__file__).parent.parent / "out"
    outdir.mkdir(exist_ok=True)

    tiles = []
    for name, v in variants(gray):
        slug = name.replace(" ", "_").replace("=", "")
        cv2.imwrite(str(outdir / f"{slug}.png"), v)
        tiles.append(label(v, name))

    # Empareja alturas dentro de cada fila antes de concatenar.
    rows = []
    for i in range(0, len(tiles), cols):
        row = tiles[i:i + cols]
        h = max(t.shape[0] for t in row)
        row = [np.vstack([t, np.full((h - t.shape[0], TILE_W, 3), 30, np.uint8)]) for t in row]
        while len(row) < cols:
            row.append(np.full((h, TILE_W, 3), 30, np.uint8))
        rows.append(np.hstack(row))

    sheet = np.vstack(rows)
    dest = outdir / "contact_sheet.png"
    cv2.imwrite(str(dest), sheet)
    print(f"hoja de contacto: {dest}")
    print(f"variantes sueltas: {outdir}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("uso: python src/contact_sheet.py <imagen>")
    main(sys.argv[1])
