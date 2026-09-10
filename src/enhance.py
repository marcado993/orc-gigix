"""
Realce de texto sobre superficies ceramicas.

Dos tipos de marca conviven en la misma pieza y necesitan tratamiento opuesto:

  - sellado con tinta -> es un problema de CONTRASTE DE COLOR.
    La tinta es oscura sobre fondo claro; CLAHE + umbral adaptativo alcanza.

  - grabado en relieve -> NO hay contraste de color, el texto y el fondo son
    el mismo material. Existe unicamente como patron de sombreado, asi que
    hay que atacarlo con derivadas direccionales, energia de textura o
    morfologia, nunca con un umbral sobre la intensidad cruda.
"""

import cv2
import numpy as np


def to_gray(img):
    if img.ndim == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return img


def norm8(a):
    """Estira cualquier array a 0-255 uint8."""
    a = a.astype(np.float32)
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    if hi - lo < 1e-6:
        return np.zeros(a.shape, np.uint8)
    return np.clip((a - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)


def flatten_illumination(gray, sigma=51):
    """
    Divide por una version muy desenfocada de si misma.

    La ceramica curva produce una rampa de iluminacion suave que domina el
    histograma y arruina cualquier umbral global. Dividiendo por la componente
    de baja frecuencia queda solo el detalle local, que es donde vive el texto.
    """
    blur = cv2.GaussianBlur(gray.astype(np.float32), (0, 0), sigma)
    blur[blur < 1] = 1
    return norm8(gray.astype(np.float32) / blur)


def clahe(gray, clip=3.0, tile=8):
    return cv2.createCLAHE(clipLimit=clip, tileGridSize=(tile, tile)).apply(gray)


def unsharp(gray, sigma=3, amount=1.5):
    blur = cv2.GaussianBlur(gray, (0, 0), sigma)
    return cv2.addWeighted(gray, 1 + amount, blur, -amount, 0)


def directional(gray, angle_deg, sigma=2):
    """
    Derivada a lo largo de la direccion de la luz.

    Un caracter en relieve genera un dipolo claro-oscuro alineado con la
    iluminacion. Proyectar el gradiente sobre ese eje convierte el dipolo en
    una senal fuerte y suprime la textura del material, que no tiene
    orientacion preferente.
    """
    g = cv2.GaussianBlur(gray.astype(np.float32), (0, 0), sigma)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=5)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=5)
    a = np.deg2rad(angle_deg)
    return norm8(gx * np.cos(a) + gy * np.sin(a))


def texture_energy(gray, win=9):
    """
    Desvio estandar local.

    Alternativa a `directional` cuando no se conoce la direccion de la luz:
    las zonas grabadas tienen alta varianza local sin importar desde donde
    venga la iluminacion. Mas robusto, pero engorda los trazos.
    """
    f = gray.astype(np.float32)
    mu = cv2.boxFilter(f, -1, (win, win))
    mu2 = cv2.boxFilter(f * f, -1, (win, win))
    return norm8(np.sqrt(np.maximum(mu2 - mu * mu, 0)))


def morph_relief(gray, stroke=9):
    """
    Blackhat + tophat con kernel del ancho del trazo.

    El metodo clasico para caracteres troquelados: el kernel debe ser algo
    mas ancho que el trazo para que el caracter quede como residuo y el
    fondo se cancele. `stroke` es el parametro a calibrar por resolucion.
    """
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (stroke, stroke))
    bh = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, k)
    th = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, k)
    return norm8(cv2.addWeighted(bh, 1.0, th, 1.0, 0))


def binarize(gray, block=35, C=10, invert=False):
    mode = cv2.THRESH_BINARY_INV if invert else cv2.THRESH_BINARY
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, mode, block | 1, C
    )


def denoise_binary(bw, min_area=40):
    """Descarta componentes chicos: polvo, poros y granulado del esmalte."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bw, 8)
    out = np.zeros_like(bw)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            out[lab == i] = 255
    return out


# --- pipelines completos -------------------------------------------------

def pipeline_ink(gray):
    """Para el texto sellado con tinta."""
    g = flatten_illumination(gray, sigma=61)
    g = clahe(g, clip=2.5)
    g = unsharp(g, sigma=2, amount=1.0)
    return g


def pipeline_relief_directional(gray, angle_deg):
    """Para el grabado, si se conoce la direccion de la luz."""
    g = flatten_illumination(gray, sigma=41)
    g = directional(g, angle_deg, sigma=2)
    return clahe(g, clip=3.0)


def pipeline_relief_morph(gray, stroke=15):
    """Para el grabado, sin asumir direccion de luz."""
    g = flatten_illumination(gray, sigma=41)
    g = morph_relief(g, stroke=stroke)
    return clahe(g, clip=3.0)


def relief_solid(gray, angle_deg=90, close=9, flat_sigma=41, denoise=True):
    """
    Grabado en relieve -> trazos solidos, listos para binarizar.

    `directional` deja cada trazo como un par de lobulos (claro/oscuro)
    separados por gris: legible a la vista, pero imposible de umbralizar.
    El valor absoluto recupera los dos bordes y el cierre morfologico los
    fusiona en un trazo lleno.

    El kernel de cierre es una LINEA perpendicular al trazo, no un disco: uno
    isotropico del mismo tamano tapa los huecos del 0, 6, 8 y 9. La
    orientacion y el largo (`close`) estan calibrados empiricamente sobre
    fotos de ~950 px de ancho; a otra resolucion hay que reescalar `close`.

    OJO con el orden: todo esto corre en resolucion NATIVA. Ampliar la imagen
    antes descoloca `flat_sigma` y `close` respecto al tamano real del trazo
    y el resultado sale hueco y ruidoso. El upscale para OCR va al final.
    """
    if denoise:
        gray = cv2.fastNlMeansDenoising(gray, None, 7, 7, 21)
    flat = flatten_illumination(gray, flat_sigma)
    d = directional(flat, angle_deg, sigma=2).astype(np.float32) - 127.5
    mag = norm8(np.abs(d))
    k = np.ones((1, close), np.uint8)
    return norm8(cv2.morphologyEx(mag, cv2.MORPH_CLOSE, k))


def relief_shadow(gray, angle_deg=90, flat_sigma=41, denoise=True):
    """
    Variante que se queda solo con el lobulo de sombra.

    Trazo mas fino y fondo mas limpio que `relief_solid`, a costa de perder
    parte del caracter. Util cuando los caracteres estan muy juntos y el
    cierre de `relief_solid` los une.
    """
    if denoise:
        gray = cv2.fastNlMeansDenoising(gray, None, 7, 7, 21)
    flat = flatten_illumination(gray, flat_sigma)
    d = directional(flat, angle_deg, sigma=2).astype(np.float32) - 127.5
    return norm8(np.maximum(-d, 0))


def estimate_text_angle(bw):
    """
    Angulo dominante del texto, por mediana de minAreaRect de cada componente.

    Mas estable que un Hough global: las estrias del material son largas y
    dominarian la votacion, mientras que aca cada caracter aporta un voto y
    los componentes con forma no-caracter quedan filtrados por area.
    """
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bw, 8)
    angles = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a < 30 or max(w, h) > 0.4 * bw.shape[1]:
            continue
        pts = cv2.findNonZero((lab == i).astype(np.uint8))
        if pts is None or len(pts) < 5:
            continue
        (_, _), (rw, rh), ang = cv2.minAreaRect(pts)
        if rw < rh:
            ang += 90
        angles.append(ang)
    return float(np.median(angles)) if angles else 0.0


def rotate(img, angle_deg, border=0):
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle_deg, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=border)


def dual_channel(gray, flat_sigma=41):
    """
    Realza las DOS marcas a la vez: grabado en relieve y sellado en tinta.

    Necesitan tratamiento opuesto. El grabado existe solo como sombreado y se
    recupera derivando. La tinta es una mancha oscura maciza: una derivada
    responde unicamente a sus bordes, asi que el interior del trazo se pierde
    y queda un contorno hueco. Atacar ambas con el mismo filtro sacrifica una.

    Devuelve (vista, localizador):

      vista       ambos canales combinados. Es lo que hay que mostrar y lo
                  que un humano lee mejor.
      localizador solo el canal de relieve. Es lo que hay que usar para
                  recortar: el canal de tinta marca todo lo mas oscuro que su
                  entorno, y un fondo desenfocado cumple esa condicion, asi
                  que estira la caja hasta el borde del encuadre.
    """
    flat = flatten_illumination(gray, flat_sigma).astype(np.float32) / 255.0

    relief = np.zeros_like(flat)
    relief[1:-1, 1:-1] = (np.abs(flat[2:, 1:-1] - flat[:-2, 1:-1])
                          + 0.5 * np.abs(flat[1:-1, 2:] - flat[1:-1, :-2]))
    ink = np.maximum(0.0, flat.mean() - flat)

    # Cada canal se estira por separado: sus rangos nativos no son comparables.
    r8, k8 = norm8(relief), norm8(ink)
    return np.maximum(r8, k8), r8
