"""
Backend del lector de piezas: recibe el recorte de la foto y lo lee con un
modelo de vision (DeepSeek u OpenAI).

Existe porque la clave de API no puede quedar expuesta en una pagina publica.
El frontend manda solo la imagen; el prompt y la lista de modelos permitidos
quedan de este lado, asi el endpoint no sirve como proxy generico.

La clave sale del .env del servidor, o de la que el usuario cargue en Ajustes
para probar otro proveedor: esa viaja en cada pedido y no se guarda aca.

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

MAX_BYTES = 4 * 1024 * 1024  # el recorte pesa ~100 KB; esto es holgura
TYPES = {"image/jpeg", "image/png", "image/webp"}

# Solo modelos baratos con vision, mas gpt-4o para poder compararlo. Una lista
# cerrada evita que alguien use la clave del servidor con un modelo caro.
PROVEEDORES = {
    "deepseek": {
        "nombre": "DeepSeek",
        "url": "https://api.deepseek.com/chat/completions",
        "env": "DEEPSEEK_API_KEY",
        "consola": "platform.deepseek.com",
        "modelos": ["deepseek-flash"],
    },
    "openai": {
        "nombre": "OpenAI",
        "url": "https://api.openai.com/v1/chat/completions",
        "env": "OPENAI_API_KEY",
        "consola": "platform.openai.com",
        "modelos": ["gpt-5.6-luna", "gpt-5.4-nano", "gpt-4.1-mini", "gpt-4o-mini", "gpt-4o"],
    },
}
PROVEEDOR_DEFECTO = "deepseek"

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

app = FastAPI(title="Lector de piezas", docs_url="/api/docs", openapi_url="/api/openapi.json")

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-codigo", "x-proveedor", "x-modelo", "x-api-key"],
    )


async def get_http():
    """Cliente HTTP hacia el proveedor. Es una dependencia para poder reemplazarlo en los tests."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10)) as client:
        yield client


def error(msg: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"error": msg, **extra}, status_code=status)


@app.get("/api/salud")
def salud():
    """Que proveedores y modelos hay, y cuales tienen clave en el servidor. Nunca expone claves."""
    return {
        "ok": True,
        "proveedor_defecto": PROVEEDOR_DEFECTO,
        "codigo_requerido": bool(os.getenv("ACCESS_CODE")),
        "proveedores": {
            pid: {
                "nombre": p["nombre"],
                "modelos": p["modelos"],
                "consola": p["consola"],
                "clave_servidor": bool(os.getenv(p["env"])),
            }
            for pid, p in PROVEEDORES.items()
        },
    }


def armar_pedido(proveedor: str, modelo: str, tipo: str, datos: bytes) -> dict:
    imagen = {"url": f"data:{tipo};base64,{base64.b64encode(datos).decode()}"}
    cuerpo = {
        "model": modelo,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": PROMPT}, {"type": "image_url", "image_url": imagen}],
        }],
    }
    if proveedor == "openai":
        # Sin "high", OpenAI puede bajar la imagen a baja resolucion y el
        # grabado se vuelve ilegible.
        imagen["detail"] = "high"
        if modelo.startswith("gpt-5"):
            # Los GPT-5 razonan y cobran ese razonamiento como salida. Para
            # transcribir no hace falta pensar mucho. Ademas rechazan
            # temperature distinto de 1.
            cuerpo["reasoning_effort"] = "low"
        else:
            cuerpo["temperature"] = 0
    else:
        cuerpo["temperature"] = 0
    return cuerpo


def explicar(proveedor: str, modelo: str, status: int, texto: str) -> tuple[str, int]:
    """Traduce el error del proveedor a que hacer, y decide el status que ve el frontend."""
    p = PROVEEDORES[proveedor]
    nombre = p["nombre"]
    if status == 401:
        return f"La clave de {nombre} es inválida. Revisala en Ajustes o en el .env del servidor.", 502
    if status == 402 or (status == 429 and "insufficient_quota" in texto):
        return f"La cuenta de {nombre} no tiene saldo o llegó a su límite de gasto. Revisá {p['consola']}.", 502
    if status == 429:
        return "Demasiadas lecturas seguidas. Esperá unos segundos.", 429
    if status == 404:
        return f"{nombre} no reconoce el modelo {modelo}, o tu cuenta no tiene acceso a él.", 502
    if status in (400, 422):
        return f"{nombre} rechazó el pedido para {modelo}. El detalle dice por qué.", 502
    if status >= 500:
        return f"{nombre} está con problemas o saturado. Probá de nuevo en un rato.", 502
    return f"{nombre} respondió con error {status}.", 502


@app.post("/api/leer")
async def leer(
    archivo: UploadFile = File(...),
    x_codigo: str | None = Header(default=None),
    x_proveedor: str | None = Header(default=None),
    x_modelo: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    http: httpx.AsyncClient = Depends(get_http),
):
    code = os.getenv("ACCESS_CODE")
    if code and x_codigo != code:
        return error("Código de acceso incorrecto.", 401, codigo=True)

    proveedor = x_proveedor or PROVEEDOR_DEFECTO
    if proveedor not in PROVEEDORES:
        return error(f"Proveedor desconocido: {proveedor}.", 400)
    p = PROVEEDORES[proveedor]
    modelo = x_modelo or p["modelos"][0]
    if modelo not in p["modelos"]:
        return error(f"El modelo {modelo} no está habilitado para {p['nombre']}.", 400)

    key = (x_api_key or "").strip() or os.getenv(p["env"])
    if not key:
        return error(f"No hay clave de {p['nombre']}: cargala en Ajustes o en el .env del servidor ({p['env']}).", 400)

    tipo = (archivo.content_type or "").split(";")[0].strip()
    if tipo not in TYPES:
        return error("Mandá la imagen como JPEG, PNG o WebP.", 415)

    datos = await archivo.read(MAX_BYTES + 1)
    if not datos:
        return error("La imagen llegó vacía.", 400)
    if len(datos) > MAX_BYTES:
        return error("La imagen supera los 4 MB. Mandá el recorte, no la foto entera.", 413)

    try:
        r = await http.post(
            p["url"],
            json=armar_pedido(proveedor, modelo, tipo, datos),
            headers={"authorization": f"Bearer {key}"},
        )
    except httpx.HTTPError as e:
        return error(f"No se pudo contactar a {p['nombre']}: {e}", 502)

    if r.status_code != 200:
        msg, status = explicar(proveedor, modelo, r.status_code, r.text)
        return error(msg, status, detalle=r.text[:400])

    try:
        data = r.json()
        contenido = data["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError):
        return error(f"{p['nombre']} devolvió una respuesta ilegible.", 502, detalle=r.text[:400])

    bloques = parse_bloques(contenido)
    if bloques is None:
        return error(f"{p['nombre']} no devolvió el JSON esperado.", 502, detalle=str(contenido)[:400])

    return {
        "bloques": bloques,
        "proveedor": proveedor,
        "modelo": data.get("model", modelo),
        "uso": data.get("usage"),
    }


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
