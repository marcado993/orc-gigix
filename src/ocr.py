"""
Motor de OCR sobre las imagenes ya realzadas por enhance.py.

Todo local, sin API. La estrategia es explotar que el problema es CERRADO:
siempre la misma fuente troquelada, siempre digitos, siempre el mismo tipo
de codigo. Restringir el charset y el modo de segmentacion sube el acierto
mucho mas que cualquier modelo generalista.
"""

import os
import re
import sys
from pathlib import Path

import cv2
import numpy as np
import pytesseract

sys.path.insert(0, str(Path(__file__).parent))
import enhance as E

# Tesseract no queda en el PATH cuando se instala con winget.
for cand in (r"C:\Program Files\Tesseract-OCR\tesseract.exe",
             os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe")):
    if os.path.exists(cand):
        pytesseract.pytesseract.tesseract_cmd = cand
        break

WHITELIST = "0123456789T-"


def config(psm, whitelist=WHITELIST):
    c = f"--oem 1 --psm {psm}"
    if whitelist:
        c += f" -c tessedit_char_whitelist={whitelist}"
    # El diccionario solo estorba: estos codigos no son palabras.
    c += " -c load_system_dawg=0 -c load_freq_dawg=0"
    return c


def read(img, psm=11, whitelist=WHITELIST):
    """Devuelve [(texto, confianza, (x,y,w,h)), ...] descartando lo vacio."""
    data = pytesseract.image_to_data(
        img, config=config(psm, whitelist), output_type=pytesseract.Output.DICT
    )
    out = []
    for i, txt in enumerate(data["text"]):
        txt = txt.strip()
        conf = float(data["conf"][i])
        if txt and conf >= 0:
            out.append((txt, conf, (data["left"][i], data["top"][i],
                                    data["width"][i], data["height"][i])))
    return out


def orient(img):
    """
    Angulo de rotacion segun el detector OSD de Tesseract.

    Resuelve la ambigüedad de 180 que el perfil de proyeccion no puede:
    la proyeccion endereza las lineas pero no sabe cual lado es arriba.
    """
    try:
        osd = pytesseract.image_to_osd(img, output_type=pytesseract.Output.DICT)
        return int(osd.get("rotate", 0)), float(osd.get("orientation_conf", 0))
    except Exception:
        return 0, 0.0


def read_best_orientation(img, psm=11):
    """Prueba las 4 rotaciones y se queda con la de mayor confianza total."""
    best = None
    for rot in (0, 90, 180, 270):
        r = np.rot90(img, rot // 90) if rot else img
        res = read(np.ascontiguousarray(r), psm)
        total = sum(c for _, c, _ in res)
        if best is None or total > best[0]:
            best = (total, rot, res)
    return best[1], best[2]


def score(found, truth):
    """Fraccion de los codigos esperados que aparecen en la salida."""
    blob = re.sub(r"\s+", "", "".join(t for t, _, _ in found))
    hits = [t for t in truth if re.sub(r"\s+", "", t) in blob]
    return len(hits) / len(truth), hits
