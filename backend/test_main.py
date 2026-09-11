"""
Tests del backend. DeepSeek se reemplaza por un transporte falso: no gastan
saldo ni necesitan clave real.

    pytest -q
"""

import base64
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import main

JPEG = b"\xff\xd8\xff\xe0" + b"0" * 64  # alcanza: el backend no decodifica la imagen


def respuesta_ok(contenido, usage=None):
    return httpx.Response(200, json={
        "model": "deepseek-flash",
        "choices": [{"message": {"content": contenido}}],
        "usage": usage or {"prompt_tokens": 700, "completion_tokens": 60},
    })


@pytest.fixture
def cliente(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.delenv("ACCESS_CODE", raising=False)
    visto = {}

    def usar(handler):
        async def http():
            def registrar(request):
                visto["request"] = request
                return handler(request)
            async with httpx.AsyncClient(transport=httpx.MockTransport(registrar)) as c:
                yield c
        main.app.dependency_overrides[main.get_http] = http
        return TestClient(main.app), visto

    yield usar
    main.app.dependency_overrides.clear()


def subir(tc, datos=JPEG, tipo="image/jpeg", headers=None):
    return tc.post("/api/leer", files={"archivo": ("pieza.jpg", datos, tipo)}, headers=headers or {})


def test_lectura_ok_y_pedido_bien_formado(cliente):
    tc, visto = cliente(lambda req: respuesta_ok(json.dumps({"bloques": [
        {"texto": "0905 76 08 30", "tipo": "grabado", "confianza": "alta"},
        {"texto": "T-5805", "tipo": "tinta", "confianza": "media"},
    ]})))
    r = subir(tc)
    assert r.status_code == 200
    body = r.json()
    assert [b["texto"] for b in body["bloques"]] == ["0905 76 08 30", "T-5805"]
    assert body["uso"]["prompt_tokens"] == 700

    sent = json.loads(visto["request"].content)
    assert sent["model"] == "deepseek-flash"
    assert sent["response_format"] == {"type": "json_object"}
    img = sent["messages"][0]["content"][1]["image_url"]["url"]
    assert img == "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
    assert visto["request"].headers["authorization"] == "Bearer sk-test"


def test_tolera_json_envuelto_en_markdown(cliente):
    tc, _ = cliente(lambda req: respuesta_ok('```json\n{"bloques":[{"texto":" 6510426090 ","tipo":"raro","confianza":"x"}]}\n```'))
    b = subir(tc).json()["bloques"]
    assert b == [{"texto": "6510426090", "tipo": "grabado", "confianza": "baja"}]


def test_json_invalido_da_502(cliente):
    tc, _ = cliente(lambda req: respuesta_ok("no puedo leer esto"))
    r = subir(tc)
    assert r.status_code == 502 and "JSON" in r.json()["error"]


@pytest.mark.parametrize("status,texto,esperado", [
    (401, "inválida", 502),
    (402, "saldo", 502),
    (429, "Esperá", 429),
])
def test_errores_de_deepseek_se_explican(cliente, status, texto, esperado):
    tc, _ = cliente(lambda req: httpx.Response(status, json={"error": "x"}))
    r = subir(tc)
    assert r.status_code == esperado and texto in r.json()["error"]


def test_sin_clave(cliente, monkeypatch):
    tc, _ = cliente(lambda req: respuesta_ok("{}"))
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    r = subir(tc)
    assert r.status_code == 500 and "DEEPSEEK_API_KEY" in r.json()["error"]


def test_codigo_de_acceso(cliente, monkeypatch):
    tc, _ = cliente(lambda req: respuesta_ok('{"bloques":[]}'))
    monkeypatch.setenv("ACCESS_CODE", "planta")
    assert subir(tc).status_code == 401
    assert subir(tc, headers={"x-codigo": "mal"}).json()["codigo"] is True
    assert subir(tc, headers={"x-codigo": "planta"}).status_code == 200


def test_tipo_y_tamano(cliente):
    tc, _ = cliente(lambda req: respuesta_ok('{"bloques":[]}'))
    assert subir(tc, datos=b"hola", tipo="text/plain").status_code == 415
    assert subir(tc, datos=b"").status_code == 400
    assert subir(tc, datos=b"0" * (main.MAX_BYTES + 1)).status_code == 413


def test_salud_no_expone_la_clave(cliente):
    tc, _ = cliente(lambda req: respuesta_ok("{}"))
    body = tc.get("/api/salud").json()
    assert body["clave_cargada"] is True
    assert "sk-test" not in json.dumps(body)
