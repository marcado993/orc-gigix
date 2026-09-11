"""
Backend del lector de piezas: recibe el recorte de la foto y lo lee con
DeepSeek Flash.

Existe por una sola razon: la clave de API no puede vivir en el navegador,
porque cualquiera la saca de ahi. El frontend manda solo la imagen; el prompt,
el modelo y la clave quedan de este lado, asi el endpoint no sirve como proxy
generico para gastar el saldo en otra cosa.

    uvicorn main:app --reload --port 8000
"""

import base64
import json
import os
import re

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
MAX_BYTES = 4 * 1024 * 1024  # el recorte pesa ~100 KB; esto es holgura
TYPES = {"image/jpeg", "image/png", "image/webp"}

PROMPT = """Eres un sistema de lectura de codigos de fabricacion sobre piezas ceramicas.

En la pieza conviven dos tipos de marca: texto GRABADO en relieve (sin color
propio, visible solo por sombras) y texto SELLADO CON TINTA (oscuro y
contrastado). El texto suele estar rotado o en diagonal, a veces cortado por
el borde del encuadre, y el material tiene estrias y poros que NO son texto.

Lee todos los bloques de texto de la imagen. Reglas:
1. Cada bloque por separado, sin mezclarlos entre si.
2. Transcribe ya corregido a lectura normal, aunque este rotado.
3. No inventes caracteres. Si uno es ilegible, pon "?" en esa posicion.
4. Ignora textura del material, sombras y reflejos: no son caracteres.
5. Transcribe literal. No corrijas el codigo hacia lo que "deberia" decir.

Responde SOLO este JSON, sin texto adicional:
{"bloques":[{"texto":"...","tipo":"grabado","confianza":"alta"}]}
donde tipo es "grabado" o "tinta", y confianza es "alta", "media" o "baja".
Si no se lee nada, devuelve {"bloques":[]}."""

# Codigos de error documentados por DeepSeek, traducidos a que hacer.
ERRORES = {
    400: "DeepSeek rechazó el formato del pedido.",
    401: "La clave de DeepSeek es inválida. Revisá DEEPSEEK_API_KEY.",
    402: "La cuenta de DeepSeek no tiene saldo. Cargá saldo en platform.deepseek.com.",
    422: "DeepSeek rechazó un parámetro del pedido.",
    429: "Demasiadas lecturas seguidas. Esperá unos segundos.",
    500: "DeepSeek está con problemas. Probá de nuevo en un rato.",
    503: "DeepSeek está saturado. Probá de nuevo en un rato.",
}

app = FastAPI(title="Lector de piezas", docs_url="/api/docs", openapi_url="/api/openapi.json")

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-codigo"],
    )


async def get_http():
    """Cliente HTTP hacia DeepSeek. Es una dependencia para poder reemplazarlo en los tests."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10)) as client:
        yield client


def error(msg: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"error": msg, **extra}, status_code=status)


@app.get("/api/salud")
def salud():
    """Dice si el backend está listo para leer, sin exponer la clave."""
    return {
        "ok": True,
        "modelo": MODEL,
        "clave_cargada": bool(os.getenv("DEEPSEEK_API_KEY")),
        "codigo_requerido": bool(os.getenv("ACCESS_CODE")),
    }


@app.post("/api/leer")
async def leer(
    archivo: UploadFile = File(...),
    x_codigo: str | None = Header(default=None),
    http: httpx.AsyncClient = Depends(get_http),
):
    key = os.getenv("DEEPSEEK_API_KEY")
    if not key:
        return error("El servidor no tiene cargada la clave de DeepSeek (DEEPSEEK_API_KEY).", 500)

    code = os.getenv("ACCESS_CODE")
    if code and x_codigo != code:
        return error("Código de acceso incorrecto.", 401, codigo=True)

    tipo = (archivo.content_type or "").split(";")[0].strip()
    if tipo not in TYPES:
        return error("Mandá la imagen como JPEG, PNG o WebP.", 415)

    datos = await archivo.read(MAX_BYTES + 1)
    if not datos:
        return error("La imagen llegó vacía.", 400)
    if len(datos) > MAX_BYTES:
        return error("La imagen supera los 4 MB. Mandá el recorte, no la foto entera.", 413)

    cuerpo = {
        "model": MODEL,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {
                    "url": f"data:{tipo};base64,{base64.b64encode(datos).decode()}",
                }},
            ],
        }],
    }

    try:
        r = await http.post(DEEPSEEK_URL, json=cuerpo, headers={"authorization": f"Bearer {key}"})
    except httpx.HTTPError as e:
        return error(f"No se pudo contactar a DeepSeek: {e}", 502)

    if r.status_code != 200:
        msg = ERRORES.get(r.status_code, f"DeepSeek respondió con error {r.status_code}.")
        return error(msg, 429 if r.status_code == 429 else 502, detalle=r.text[:400])

    try:
        data = r.json()
        contenido = data["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError):
        return error("DeepSeek devolvió una respuesta ilegible.", 502, detalle=r.text[:400])

    bloques = parse_bloques(contenido)
    if bloques is None:
        return error("DeepSeek no devolvió el JSON esperado.", 502, detalle=str(contenido)[:400])

    return {"bloques": bloques, "modelo": data.get("model", MODEL), "uso": data.get("usage")}


def parse_bloques(contenido: str):
    """Extrae la lista de bloques. Tolera ```json y texto alrededor del objeto."""
    s = re.sub(r"^```(?:json)?\s*|```\s*$", "", str(contenido).strip(), flags=re.I)
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        obj = json.loads(s[a:b + 1])
    except ValueError:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("bloques"), list):
        return None
    return [
        {
            "texto": x["texto"].strip(),
            "tipo": "tinta" if x.get("tipo") == "tinta" else "grabado",
            "confianza": x.get("confianza") if x.get("confianza") in ("alta", "media", "baja") else "baja",
        }
        for x in obj["bloques"]
        if isinstance(x, dict) and isinstance(x.get("texto"), str)
    ]
