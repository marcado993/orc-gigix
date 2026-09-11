/* Llamada al backend. La usan la lectura normal y el comparador de modelos. */

export type Bloque = { texto: string; tipo: "grabado" | "tinta"; confianza: "alta" | "media" | "baja" };
export type Uso = { prompt_tokens?: number; completion_tokens?: number };
export type Lectura = { bloques: Bloque[]; proveedor: string; modelo: string; uso: Uso | null };

const CODE_KEY = "codigoAcceso";

function leerCodigo(): string {
  try { return localStorage.getItem(CODE_KEY) ?? ""; } catch { return ""; }
}
function guardarCodigo(c: string) {
  try { localStorage.setItem(CODE_KEY, c); } catch { /* sin almacenamiento: se vuelve a pedir */ }
}

/* El prompt vive en el backend: desde aca viajan la imagen y que modelo usar. */
export async function leerPieza(
  blob: Blob,
  proveedor: string,
  modelo: string,
  clave?: string,
  retry = true,
): Promise<Lectura> {
  const fd = new FormData();
  fd.append("archivo", blob, "pieza.jpg");
  const headers: Record<string, string> = { "x-proveedor": proveedor, "x-modelo": modelo };
  const code = leerCodigo();
  if (code) headers["x-codigo"] = code;
  if (clave) headers["x-api-key"] = clave;

  const r = await fetch("/api/leer", { method: "POST", body: fd, headers });
  const text = await r.text();
  let data: { error?: string; codigo?: boolean } & Partial<Lectura>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      r.status >= 500
        ? "No se pudo contactar al backend. ¿Está corriendo?"
        : "El servidor devolvió una respuesta ilegible.",
    );
  }
  if (r.status === 401 && data.codigo && retry) {
    const c = window.prompt("Código de acceso para leer piezas:");
    if (c) {
      guardarCodigo(c.trim());
      return leerPieza(blob, proveedor, modelo, clave, false);
    }
  }
  if (!r.ok) throw new Error(data.error ?? `error ${r.status}`);
  return data as Lectura;
}
