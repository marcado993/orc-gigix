/*
 * Preprocesado en el navegador: puerto del pipeline validado en OpenCV
 * (src/enhance.py). Corre en el equipo que captura la foto, sin costo, y es
 * lo que abarata cada lectura: los tokens de imagen son proporcionales a los
 * pixeles enviados, y aca se recorta la foto a la zona con texto.
 */

export type Gray = { g: Float32Array; w: number; h: number; canvas: HTMLCanvasElement };
export type Box = [number, number, number, number];

export function toGray(bmp: ImageBitmap, maxW = 1100): Gray {
  const s = Math.min(1, maxW / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext("2d", { willReadFrequently: true });
  if (!cx) throw new Error("el navegador no permite procesar imágenes");
  cx.drawImage(bmp, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return { g, w, h, canvas };
}

/* Box blur separable: aproximacion barata de una gaussiana grande. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  const cx = (x: number) => Math.min(w - 1, Math.max(0, x));
  const cy = (y: number) => Math.min(h - 1, Math.max(0, y));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + cx(x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + cx(x + r + 1)] - src[row + cx(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[cy(y) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[cy(y + r + 1) * w + x] - tmp[cy(y - r) * w + x];
    }
  }
  return out;
}

/* Estira un canal a 0-255 recortando colas; `hi` es el umbral texto/fondo. */
function stretch(src: Float32Array): { out: Float32Array; hi: number } {
  const sorted = Float32Array.from(src).sort();
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const lo = at(0.02);
  const span = Math.max(1e-6, at(0.995) - lo);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.max(0, Math.min(255, ((src[i] - lo) / span) * 255));
  return { out, hi: Math.max(0, Math.min(255, ((at(0.985) - lo) / span) * 255)) };
}

/*
 * Dos marcas conviven en la pieza y necesitan tratamiento OPUESTO.
 *
 * RELIEVE: texto y fondo son el mismo material; la marca existe solo como
 * sombreado y se recupera derivando.
 *
 * TINTA: mancha oscura maciza. Una derivada responde solo a los bordes, asi
 * que el interior del trazo desaparece. Necesita su propio canal, por
 * intensidad respecto al fondo local.
 *
 * `view` combina ambos (lo que se muestra). `find` es solo relieve (lo que
 * localiza el recorte): el canal de tinta marca cualquier cosa mas oscura que
 * su entorno, incluido el fondo desenfocado del taller, y estira la caja
 * hasta el borde de la foto.
 */
export function enhance(gray: Float32Array, w: number, h: number) {
  const n = w * h;
  const blur = boxBlur(gray, w, h, Math.max(6, Math.round(Math.min(w, h) / 22)));
  const flat = new Float32Array(n);
  for (let i = 0; i < n; i++) flat[i] = gray[i] / Math.max(1, blur[i]);

  const relief = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      relief[i] = Math.abs(flat[i + w] - flat[i - w]) + 0.5 * Math.abs(flat[i + 1] - flat[i - 1]);
    }
  }
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i++) ink[i] = Math.max(0, 1 - flat[i]);

  const R = stretch(relief);
  const K = stretch(ink);
  const view = new Uint8ClampedArray(n);
  const find = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    view[i] = Math.max(R.out[i], K.out[i]);
    find[i] = R.out[i];
  }
  return { view, find, thresh: R.hi };
}

/* Caja de la zona con texto, por perfiles de energia en cada eje. */
export function roi(en: Uint8ClampedArray, w: number, h: number, thresh: number): Box {
  const colE = new Float32Array(w);
  const rowE = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (en[y * w + x] > thresh) {
        colE[x]++;
        rowE[y]++;
      }
    }
  }
  const span = (arr: Float32Array, len: number): [number, number] => {
    let peak = 0;
    for (let i = 0; i < len; i++) if (arr[i] > peak) peak = arr[i];
    if (peak <= 0) return [0, len - 1];
    const t = peak * 0.16;
    let a = 0;
    let b = len - 1;
    while (a < len && arr[a] < t) a++;
    while (b > a && arr[b] < t) b--;
    return [a, b];
  };
  const [xa, xb] = span(colE, w);
  const [ya, yb] = span(rowE, h);
  const mx = Math.round(w * 0.05);
  const my = Math.round(h * 0.05);
  const x0 = Math.max(0, xa - mx), x1 = Math.min(w - 1, xb + mx);
  const y0 = Math.max(0, ya - my), y1 = Math.min(h - 1, yb + my);
  /* Un recorte degenerado significa que la deteccion fallo: mejor mandar todo. */
  if (x1 - x0 < w * 0.15 || y1 - y0 < h * 0.15) return [0, 0, w - 1, h - 1];
  return [x0, y0, x1, y1];
}

export function paint(canvas: HTMLCanvasElement, data: Uint8ClampedArray, w: number, h: number, box?: Box) {
  canvas.width = w;
  canvas.height = h;
  const cx = canvas.getContext("2d");
  if (!cx) return;
  const im = cx.createImageData(w, h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    im.data[p] = im.data[p + 1] = im.data[p + 2] = data[i];
    im.data[p + 3] = 255;
  }
  cx.putImageData(im, 0, 0);
  if (box) {
    cx.strokeStyle = "#35BDB6";
    cx.lineWidth = Math.max(2, Math.round(w / 180));
    cx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
  }
}

/*
 * Recorte de la foto REAL (no del realce): el modelo lee mejor la textura
 * original. Nunca se amplia: interpolar no agrega detalle y el costo es
 * proporcional a los pixeles enviados.
 */
export function crop(gr: Gray, box: Box): HTMLCanvasElement {
  const cw = box[2] - box[0] + 1;
  const ch = box[3] - box[1] + 1;
  const scale = Math.min(1, 900 / Math.max(cw, ch));
  const out = document.createElement("canvas");
  out.width = Math.round(cw * scale);
  out.height = Math.round(ch * scale);
  out.getContext("2d")?.drawImage(gr.canvas, box[0], box[1], cw, ch, 0, 0, out.width, out.height);
  return out;
}

export function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error("no se pudo codificar el recorte"))), "image/jpeg", 0.9),
  );
}
