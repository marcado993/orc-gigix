/*
 * Tarifas publicas por millon de tokens (entrada / salida), septiembre 2026.
 *
 * Cada proveedor convierte la imagen a tokens con su propia regla, y eso pesa
 * mas que el precio por token: gpt-4o-mini tiene tokens baratos pero cobra
 * cada imagen como ~25.000 tokens, y termina mas caro que gpt-4o. Por eso
 * cada motor lleva su funcion `tok`, que se evalua sobre el recorte real.
 */

export const PROMPT_TOK = 220;
export const OUT_TOK = 90;
export const TYPICAL = { w: 597, h: 558 }; // recorte medido sobre la foto de prueba
export const FOTO_TIPICA = { w: 3024, h: 4032 }; // foto de celular de 12 MP

type Tok = (w: number, h: number) => number;

/* Claude (y aproximacion para Gemini): pixeles / 750, despues de que el
   proveedor achica la imagen a 1568 px de lado y ~1,15 MP. */
const porArea: Tok = (w, h) => {
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
  return Math.round((w * s * h * s) / 750);
};

/* OpenAI, familia por parches: la imagen se ajusta a 2048 px, se cuentan
   parches de 32 px (con tope si el modelo lo tiene) y se aplica el
   multiplicador del modelo. */
const parches = (mult: number, maxParches = Infinity): Tok => (w, h) => {
  const s = Math.min(1, 2048 / Math.max(w, h));
  let ww = w * s, hh = h * s;
  let n = Math.ceil(ww / 32) * Math.ceil(hh / 32);
  if (n > maxParches) {
    const k = Math.sqrt(maxParches / n);
    ww *= k;
    hh *= k;
    n = Math.min(maxParches, Math.ceil(ww / 32) * Math.ceil(hh / 32));
  }
  return Math.ceil(n * mult);
};

/* OpenAI, familia por mosaicos: base + costo por mosaico de 512 px, en detalle alto. */
const mosaicos = (base: number, porMosaico: number): Tok => (w, h) => {
  const s = Math.min(1, 2048 / Math.max(w, h));
  let ww = w * s, hh = h * s;
  if (Math.min(ww, hh) > 768) {
    const k = 768 / Math.min(ww, hh);
    ww *= k;
    hh *= k;
  }
  return base + porMosaico * Math.ceil(ww / 512) * Math.ceil(hh / 512);
};

/* DeepSeek no publica su formula, solo el tope: se usa el tope para no subestimar. */
const fijo = (t: number): Tok => () => t;

export type Engine = {
  id: string;
  name: string;
  sub: string;
  /* modelo seleccionable en Ajustes, si lo es */
  modelo?: string;
  in: number;
  out: number;
  flat?: number;
  tok: Tok;
  dead?: boolean;
};

export const ENGINES: Engine[] = [
  { id: "tess", name: "OCR local (Tesseract)", sub: "gratis, pero no leyó el grabado en las pruebas", in: 0, out: 0, flat: 0, tok: fijo(0), dead: true },
  { id: "ds-off", name: "DeepSeek Flash · fuera de pico", sub: "cifra al tope de 1.024 tokens por imagen", modelo: "deepseek-flash", in: 0.15, out: 0.6, tok: fijo(1024) },
  { id: "ds-peak", name: "DeepSeek Flash · hora pico", sub: "lun–vie, 01–04 y 06–10 UTC", in: 0.3, out: 1.2, tok: fijo(1024) },
  { id: "luna", name: "GPT-5.6 Luna", sub: "el recomendado en OpenAI", modelo: "gpt-5.6-luna", in: 0.2, out: 1.2, tok: parches(1.2, 30000) },
  { id: "nano54", name: "GPT-5.4 nano", sub: "mismo costo por imagen que Luna, generación anterior", modelo: "gpt-5.4-nano", in: 0.2, out: 1.25, tok: parches(1.2, 2500) },
  { id: "nano5", name: "GPT-5 nano", sub: "el más barato, pero se retira el 11 dic 2026", modelo: "gpt-5-nano", in: 0.05, out: 0.4, tok: parches(1.5) },
  { id: "nano41", name: "GPT-4.1 nano", sub: "se retira el 23 oct 2026; imagen 2,46×", modelo: "gpt-4.1-nano", in: 0.1, out: 0.4, tok: parches(2.46, 1536) },
  { id: "mini5", name: "GPT-5 mini", sub: "se retira el 11 dic 2026", modelo: "gpt-5-mini", in: 0.25, out: 2, tok: parches(1.2) },
  { id: "mini41", name: "GPT-4.1 mini", sub: "multiplicador de imagen 1,62×", modelo: "gpt-4.1-mini", in: 0.4, out: 1.6, tok: parches(1.62, 1536) },
  { id: "4omini", name: "GPT-4o mini", sub: "tokens baratos, pero cada imagen cuenta como ~25.000", modelo: "gpt-4o-mini", in: 0.15, out: 0.6, tok: mosaicos(2833, 5667) },
  { id: "4o", name: "GPT-4o", sub: "modelo anterior, como referencia de comparación", modelo: "gpt-4o", in: 2.5, out: 10, tok: mosaicos(85, 170) },
  { id: "gem31", name: "Gemini 3.1 Flash-Lite", sub: "tokens de imagen aproximados", in: 0.25, out: 1.5, tok: porArea },
  { id: "haiku", name: "Claude Haiku 4.5", sub: "tiempo real", in: 1, out: 5, tok: porArea },
  { id: "gvis", name: "Google Cloud Vision OCR", sub: "OCR clásico, sin modelo de lenguaje", in: 0, out: 0, flat: 0.0015, tok: fijo(0) },
  { id: "sonnet", name: "Claude Sonnet 5", sub: "solo como escalado de lo que falla", in: 2, out: 10, tok: porArea },
];

export function costOf(e: Engine, w: number, h: number): number {
  if (e.flat !== undefined) return e.flat;
  return ((e.tok(w, h) + PROMPT_TOK) / 1e6) * e.in + (OUT_TOK / 1e6) * e.out;
}

/* Costo con los tokens que el proveedor efectivamente facturo. `modelo` es el
   pedido; si viene el nombre con fecha que devuelve el proveedor, se busca el
   prefijo mas largo, asi "gpt-4o-mini-2024..." no se confunde con gpt-4o. */
export function costoReal(modelo: string, promptTok: number, outTok: number) {
  const precio = (inp: number, out: number) => (promptTok / 1e6) * inp + (outTok / 1e6) * out;
  if (modelo.startsWith("deepseek")) return { base: precio(0.15, 0.6), pico: precio(0.3, 1.2) };
  const e = ENGINES.filter(x => x.modelo && modelo.startsWith(x.modelo))
    .sort((a, b) => (b.modelo?.length ?? 0) - (a.modelo?.length ?? 0))[0];
  return e ? { base: precio(e.in, e.out), pico: null } : null;
}

export function engineDe(modelo: string): Engine | undefined {
  return ENGINES.find(e => e.modelo === modelo);
}

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toFixed(6).replace(/0+$/, "");
  return "$" + v.toFixed(2);
}

export function porCentavo(v: number): string {
  if (v <= 0) return "—";
  const n = 0.01 / v;
  return n >= 10 ? Math.round(n).toString() : n.toFixed(1);
}

export type Medidas = { w: number; h: number };

/* Proyeccion de costo para `n` imagenes: recorte de la app contra foto entera. */
export function proyectar(e: Engine, recorte: Medidas, entera: Medidas, n: number) {
  const cRec = costOf(e, recorte.w, recorte.h);
  const cEnt = costOf(e, entera.w, entera.h);
  return {
    tokRec: e.tok(recorte.w, recorte.h),
    tokEnt: e.tok(entera.w, entera.h),
    porImgRec: cRec,
    porImgEnt: cEnt,
    totalRec: cRec * n,
    totalEnt: cEnt * n,
    pct: cEnt > 0 ? Math.round((1 - cRec / cEnt) * 100) : 0,
  };
}
