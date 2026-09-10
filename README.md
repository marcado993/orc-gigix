# Lector de códigos en piezas cerámicas

Lectura de códigos de fabricación troquelados y sellados sobre sanitarios
cerámicos. El problema tiene dos marcas conviviendo en la misma pieza:

- **Sellado con tinta** — oscuro sobre fondo claro. Problema de contraste de color.
- **Grabado en relieve** — el texto y el fondo son el mismo material. No existe
  como diferencia de color, solo como patrón de sombreado.

Esa segunda marca es la difícil, y define todo el diseño.

## Estado

| Pieza | Estado |
|---|---|
| Preprocesado (realce de relieve) | Funciona, validado sobre foto real |
| Detección automática de la zona de texto | Funciona, ~72% menos tokens |
| Corrección de rotación | Funciona por bloque; queda la ambigüedad de 180° |
| OCR con Tesseract | **Descartado** — no lee esta fuente |
| Lectura con modelo de visión | Funciona, app móvil publicada |
| Tasa de acierto medida | **Pendiente** — hay una sola foto de prueba |

## Por qué se descartó Tesseract

Se probaron ~150 combinaciones: tres familias de realce (derivada direccional,
energía de textura, morfología), ambos lóbulos del dipolo por separado y el
absoluto, relleno de huecos filtrado por tamaño, binarización adaptativa y
Otsu, charset restringido, todos los modos PSM, segmentación por línea y
enderezado fino por bloque.

El mejor resultado fue algún dígito suelto. Nunca un código completo.

Tres causas, en orden de peso:

1. **Resolución.** La foto de prueba es 952×1269 en webp de 65 KB. Los
   caracteres miden ~25-35 px y ya pasaron por compresión con pérdida.
   Tesseract quiere 30-40 px de glifo limpio.
2. **La fuente.** Tipografía de troquel industrial; el modelo `eng` está
   entrenado con tipografías de documento. Está fuera de distribución.
3. **El relieve es sombreado.** Cualquier método basado en derivadas devuelve
   contornos huecos o trazos de un solo lado, nunca el glifo macizo que
   Tesseract espera. Es estructural, no de calibración.

Coincide con lo que hace la industria: Cognex y Keyence atacan texto grabado
con iluminación controlada más OCR entrenado sobre pocas muestras.

## Costo por 10.000 imágenes

Medido sobre un recorte real de 597×558 = 444 tokens de imagen, más ~220 de
instrucción y ~90 de respuesta.

| Motor | Por imagen | 10.000 |
|---|---:|---:|
| OCR local (Tesseract) | $0 | no funciona |
| Gemini 2.5 Flash-Lite | $0.000102 | $1.02 |
| Claude Haiku 4.5 · Batch | $0.000557 | $5.57 |
| Claude Haiku 4.5 | $0.001114 | $11.14 |
| Google Cloud Vision OCR | $0.0015 | $15.00 |
| Claude Sonnet 5 | $0.002228 | $22.28 |

Escalado por tiers, con validación local decidiendo cuándo subir de nivel:
**≈ $4.40 por 10.000**. El reparto entre tiers es una estimación, no un dato.

## Estructura

```
src/enhance.py         métodos de realce, cada uno con el porqué
src/contact_sheet.py   corre las 13 variantes sobre una foto y arma la comparativa
src/ocr.py             motor Tesseract (conservado como evidencia del descarte)
app/lector.html        app web: preprocesado en el cliente + lectura con modelo
```

## Uso

Comparar métodos de realce sobre una foto:

```bash
python src/contact_sheet.py input/pieza01.webp
```

Deja `out/contact_sheet.png` con las 13 variantes lado a lado, más cada una
por separado.

Dependencias: `opencv-python-headless`, `numpy`. Para `src/ocr.py` hace falta
además el binario de Tesseract y `pytesseract`.

## Trampas ya pisadas

Están documentadas en el código, pero vale tenerlas juntas:

- **Procesar en resolución nativa y ampliar al final.** Al revés, los sigmas y
  kernels quedan descalibrados respecto al tamaño real del trazo y los trazos
  salen huecos y ruidosos.
- **El kernel de cierre tiene que ser una línea, no un disco.** Uno isotrópico
  del mismo tamaño tapa los huecos del 0, 6, 8 y 9.
- **Proyectar píxeles en vez de centroides da picos falsos en 45° y −45°**, por
  cuantización de la retícula sobre coordenadas enteras.
- **`minAreaRect` sobre caracteres sueltos no sirve para estimar el ángulo:**
  un dígito es casi cuadrado y su rectángulo mínimo da un ángulo arbitrario.
  El ángulo sale de la línea, no del carácter.
- **No ampliar el recorte antes de enviarlo al modelo.** Interpolar no agrega
  detalle y el costo es proporcional a los píxeles enviados.

## Lo próximo

1. Conseguir la foto original sin comprimir. Es la palanca más grande y es gratis.
2. Probar iluminación rasante en la captura: convierte el relieve en contraste
   real y vuelve fácil todo lo que sigue.
3. Juntar 20-30 fotos etiquetadas para medir la tasa de acierto de verdad.
4. Con ese set, evaluar template matching: fuente fija y ~12 caracteres
   posibles es donde vive la solución determinista y gratuita.
