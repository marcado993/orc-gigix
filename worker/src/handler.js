/*
 * Servidor del lector: sirve la app y hace de intermediario con DeepSeek.
 *
 * Existe por una sola razon: la clave de API no puede vivir en la pagina,
 * porque cualquiera la saca del navegador. La app manda solo el recorte de
 * la foto; el prompt, el modelo y la clave quedan de este lado, asi el
 * endpoint no sirve como proxy generico para usar el saldo en otra cosa.
 *
 * El mismo handler corre en Cloudflare Workers (src/index.js) y en Node
 * para pruebas locales (dev.mjs).
 */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-flash";
const MAX_BYTES = 4 * 1024 * 1024; // el recorte pesa ~100 KB; esto es holgura

const PROMPT = [
  "Eres un sistema de lectura de codigos de fabricacion sobre piezas ceramicas.",
  "",
  "En la pieza conviven dos tipos de marca: texto GRABADO en relieve (sin color",
  "propio, visible solo por sombras) y texto SELLADO CON TINTA (oscuro y",
  "contrastado). El texto suele estar rotado o en diagonal, a veces cortado por",
  "el borde del encuadre, y el material tiene estrias y poros que NO son texto.",
  "",
  "Lee todos los bloques de texto de la imagen. Reglas:",
  "1. Cada bloque por separado, sin mezclarlos entre si.",
  "2. Transcribe ya corregido a lectura normal, aunque este rotado.",
  "3. No inventes caracteres. Si uno es ilegible, pon \"?\" en esa posicion.",
  "4. Ignora textura del material, sombras y reflejos: no son caracteres.",
  "5. Transcribe literal. No corrijas el codigo hacia lo que \"deberia\" decir.",
  "",
  "Responde SOLO este JSON, sin texto adicional:",
  "{\"bloques\":[{\"texto\":\"...\",\"tipo\":\"grabado\",\"confianza\":\"alta\"}]}",
  "donde tipo es \"grabado\" o \"tinta\", y confianza es \"alta\", \"media\" o \"baja\".",
  "Si no se lee nada, devuelve {\"bloques\":[]}."
].join("\n");

const TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function handle(request, env, html) {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }

  if (url.pathname === "/api/leer") {
    if (request.method !== "POST") return json({ error: "Usá POST con la imagen en el cuerpo." }, 405);
    return leer(request, env);
  }

  return new Response("No encontrado", { status: 404 });
}

async function leer(request, env) {
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: "El servidor no tiene cargada la clave de DeepSeek (DEEPSEEK_API_KEY)." }, 500);
  }
  if (env.ACCESS_CODE && request.headers.get("x-codigo") !== env.ACCESS_CODE) {
    return json({ error: "Código de acceso incorrecto.", codigo: true }, 401);
  }

  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!TYPES.includes(type)) {
    return json({ error: "Mandá la imagen como image/jpeg, image/png o image/webp." }, 415);
  }
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: "La imagen llegó vacía." }, 400);
  if (buf.byteLength > MAX_BYTES) return json({ error: "La imagen supera los 4 MB. Mandá el recorte, no la foto entera." }, 413);

  const body = {
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: PROMPT },
        { type: "image_url", image_url: { url: "data:" + type + ";base64," + toBase64(buf) } }
      ]
    }]
  };

  let r;
  try {
    r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.DEEPSEEK_API_KEY },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return json({ error: "No se pudo contactar a DeepSeek: " + e.message }, 502);
  }

  const text = await r.text();
  if (!r.ok) {
    return json({ error: explain(r.status), detalle: text.slice(0, 400) }, r.status === 429 ? 429 : 502);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    return json({ error: "DeepSeek devolvió una respuesta ilegible.", detalle: text.slice(0, 400) }, 502);
  }
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  const bloques = parseBloques(content);
  if (!bloques) {
    return json({ error: "DeepSeek no devolvió el JSON esperado.", detalle: String(content).slice(0, 400) }, 502);
  }
  return json({ bloques, modelo: data.model || MODEL, uso: data.usage || null });
}

/* Codigos de error documentados por DeepSeek, traducidos a que hacer. */
function explain(status) {
  switch (status) {
    case 400: return "DeepSeek rechazó el formato del pedido.";
    case 401: return "La clave de DeepSeek es inválida. Revisá DEEPSEEK_API_KEY.";
    case 402: return "La cuenta de DeepSeek no tiene saldo. Cargá saldo en platform.deepseek.com.";
    case 422: return "DeepSeek rechazó un parámetro del pedido.";
    case 429: return "Demasiadas lecturas seguidas. Esperá unos segundos.";
    case 500:
    case 503: return "DeepSeek está con problemas o saturado. Probá de nuevo en un rato.";
    default:  return "DeepSeek respondió con error " + status + ".";
  }
}

/* Tolera respuestas envueltas en ```json o con texto alrededor. */
function parseBloques(content) {
  let s = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!obj || !Array.isArray(obj.bloques)) return null;
  return obj.bloques
    .filter(x => x && typeof x.texto === "string")
    .map(x => ({
      texto: x.texto.trim(),
      tipo: x.tipo === "tinta" ? "tinta" : "grabado",
      confianza: ["alta", "media", "baja"].includes(x.confianza) ? x.confianza : "baja"
    }));
}

/* btoa por tramos: String.fromCharCode con un array grande revienta la pila. */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
