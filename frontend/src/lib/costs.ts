/*
 * Tarifas publicas por millon de tokens (entrada / salida), septiembre 2026.
 * Google Vision cobra por imagen, de ahi `flat`. DeepSeek no publica su
 * formula de tokens por imagen, solo el tope de 1.024: se usa el tope para no
 * subestimar, y la app lo reemplaza por los tokens reales despues de leer.
 */

export const PROMPT_TOK = 220;
export const OUT_TOK = 90;
export const TYPICAL_TOK = 444; // recorte medido sobre la foto de prueba

export type Engine = {
  id: string;
  name: string;
  sub: string;
  in?: number;
  out?: number;
  flat?: number;
  imgTok?: number;
  dead?: boolean;
};

export const ENGINE_NOW = "dsOff";

export const ENGINES: Engine[] = [
  { id: "tess", name: "OCR local (Tesseract)", sub: "gratis, pero no leyó el grabado en las pruebas", flat: 0, dead: true },
  { id: "dsOff", name: "DeepSeek Flash · fuera de pico", sub: "el más barato vigente; cifra al tope de 1.024 tokens por imagen", in: 0.15, out: 0.6, imgTok: 1024 },
  { id: "dsPk", name: "DeepSeek Flash · hora pico", sub: "lun–vie, 01–04 y 06–10 UTC", in: 0.3, out: 1.2, imgTok: 1024 },
  { id: "gem31", name: "Gemini 3.1 Flash-Lite", sub: "reemplazo de 2.5 Flash-Lite, que se retira el 16 oct 2026", in: 0.25, out: 1.5 },
  { id: "haikuB", name: "Claude Haiku 4.5 · Batch", sub: "mitad de precio, resultados diferidos", in: 0.5, out: 2.5 },
  { id: "haiku", name: "Claude Haiku 4.5", sub: "tiempo real", in: 1, out: 5 },
  { id: "gvis", name: "Google Cloud Vision OCR", sub: "OCR clásico, sin modelo de lenguaje", flat: 0.0015 },
  { id: "sonnet", name: "Claude Sonnet 5", sub: "solo como escalado de lo que falla", in: 2, out: 10 },
];

export function costOf(e: Engine, imgTok: number): number {
  if (e.flat !== undefined) return e.flat;
  const t = e.imgTok ?? imgTok;
  return ((t + PROMPT_TOK) / 1e6) * (e.in ?? 0) + (OUT_TOK / 1e6) * (e.out ?? 0);
}

/* Costo de DeepSeek con los tokens que efectivamente facturo. */
export function deepseekReal(promptTok: number, outTok: number) {
  return {
    off: (promptTok / 1e6) * 0.15 + (outTok / 1e6) * 0.6,
    peak: (promptTok / 1e6) * 0.3 + (outTok / 1e6) * 1.2,
  };
}

export function money(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toFixed(6).replace(/0+$/, "");
  return "$" + v.toFixed(2);
}
