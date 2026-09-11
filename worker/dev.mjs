// Servidor local de pruebas: corre el mismo handler que Cloudflare, sin
// instalar nada (Node 18+ trae fetch, Request y Response).
//
//   cd worker
//   copy .dev.vars.example .dev.vars   (y pegar la clave)
//   node dev.mjs
//
// La app se relee en cada pedido, asi los cambios en app/lector.html se ven
// con solo recargar la pagina.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { handle } from "./src/handler.js";

const PORT = Number(process.env.PORT || 8787);
const KEYS = ["DEEPSEEK_API_KEY", "ACCESS_CODE"];

async function loadEnv() {
  const env = {};
  try {
    const text = await readFile(new URL(".dev.vars", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && KEYS.includes(m[1]) && m[2]) env[m[1]] = m[2];
    }
  } catch { /* sin .dev.vars: se usan las variables de entorno */ }
  for (const k of KEYS) if (process.env[k]) env[k] = process.env[k];
  return env;
}

http.createServer(async (req, res) => {
  try {
    const html = await readFile(new URL("../app/lector.html", import.meta.url), "utf8");
    const env = await loadEnv();
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const headers = {};
    for (const h of ["content-type", "x-codigo"]) if (req.headers[h]) headers[h] = req.headers[h];
    const request = new Request("http://localhost:" + PORT + req.url, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined
    });
    const response = await handle(request, env, html);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(req.method, req.url, response.status);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Error del servidor local: " + e.message);
    console.error(e);
  }
}).listen(PORT, async () => {
  const env = await loadEnv();
  console.log("Lector en http://localhost:" + PORT);
  console.log("Clave DeepSeek: " + (env.DEEPSEEK_API_KEY ? "cargada" : "FALTA (crear worker/.dev.vars)"));
  console.log("Codigo de acceso: " + (env.ACCESS_CODE ? "activo" : "desactivado"));
});
