/*
 * El formato de los codigos es cerrado, y eso permite decidir localmente si
 * una lectura sirve. Es la pieza que habilita escalar a un modelo mas caro
 * solo cuando hace falta.
 */

const PATTERNS = [
  { re: /^\d{4}\s?\d{2}\s?\d{2}\s?\d{2}$/, name: "fecha/turno" },
  { re: /^\d{9,12}$/, name: "referencia" },
  { re: /^[A-Z]-?\d{3,5}$/, name: "molde" },
];

export type Veredicto = { cls: "ok" | "warn" | "bad"; txt: string };

export function validate(t: string): Veredicto {
  const s = (t || "").trim().toUpperCase();
  if (!s) return { cls: "bad", txt: "vacío" };
  for (const p of PATTERNS) if (p.re.test(s)) return { cls: "ok", txt: p.name };
  if (s.includes("?")) return { cls: "warn", txt: "dudoso" };
  return { cls: "warn", txt: "sin formato" };
}
