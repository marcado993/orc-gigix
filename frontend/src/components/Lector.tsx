"use client";

import { useEffect, useRef, useState } from "react";
import { crop, enhance, paint, roi, toGray, toJpeg } from "@/lib/preprocess";
import { deepseekReal, ENGINE_NOW, ENGINES, costOf, money, TYPICAL_TOK } from "@/lib/costs";
import { validate } from "@/lib/validate";

type Bloque = { texto: string; tipo: "grabado" | "tinta"; confianza: "alta" | "media" | "baja" };
type Uso = { prompt_tokens?: number; completion_tokens?: number };
type Lectura = { bloques: Bloque[]; modelo: string; uso: Uso | null };
type Salud = { ok: boolean; modelo: string; clave_cargada: boolean; codigo_requerido: boolean };
type Medida = { w: number; h: number; tok: number; fullTok: number };
type Estado = { msg: string; kind?: "err" | "go" };

const CODE_KEY = "codigoAcceso";

function leerCodigo(): string {
  try { return localStorage.getItem(CODE_KEY) ?? ""; } catch { return ""; }
}
function guardarCodigo(c: string) {
  try { localStorage.setItem(CODE_KEY, c); } catch { /* sin almacenamiento: se vuelve a pedir */ }
}

/* El prompt vive en el backend: desde aca solo viaja la imagen. */
async function leerPieza(blob: Blob, retry = true): Promise<Lectura> {
  const fd = new FormData();
  fd.append("archivo", blob, "recorte.jpg");
  const code = leerCodigo();
  const r = await fetch("/api/leer", { method: "POST", body: fd, headers: code ? { "x-codigo": code } : {} });
  const text = await r.text();
  let data: { error?: string; codigo?: boolean } & Partial<Lectura>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      r.status >= 500
        ? "No se pudo contactar al backend. ¿Está corriendo en el puerto 8000?"
        : "El servidor devolvió una respuesta ilegible.",
    );
  }
  if (r.status === 401 && data.codigo && retry) {
    const c = window.prompt("Código de acceso para leer piezas:");
    if (c) {
      guardarCodigo(c.trim());
      return leerPieza(blob, false);
    }
  }
  if (!r.ok) throw new Error(data.error ?? `error ${r.status}`);
  return data as Lectura;
}

function Fila({ b, i }: { b: Bloque; i: number }) {
  const [valor, setValor] = useState(b.texto);
  const v = validate(valor);
  return (
    <div className="row">
      <div>
        <span className="rl">
          {b.tipo === "tinta" ? "Sellado en tinta" : "Grabado en relieve"} · confianza {b.confianza}
        </span>
        <input
          value={valor}
          onChange={e => setValor(e.target.value)}
          spellCheck={false}
          aria-label={`Código leído ${i + 1}`}
        />
      </div>
      <span className={`chip ${v.cls}`}>{v.txt}</span>
    </div>
  );
}

export default function Lector() {
  const orig = useRef<HTMLCanvasElement>(null);
  const proc = useRef<HTMLCanvasElement>(null);
  const camara = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);

  const [salud, setSalud] = useState<Salud | null | "caido">(null);
  const [estado, setEstado] = useState<Estado>({ msg: "Comprobando el backend…" });
  const [busy, setBusy] = useState(false);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [lecturaId, setLecturaId] = useState(0);
  const [medida, setMedida] = useState<Medida | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch("/api/salud")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Salud) => {
        if (!vivo) return;
        setSalud(s);
        setEstado(
          s.clave_cargada
            ? { msg: "Listo: sacá o subí una foto de la pieza." }
            : { msg: "El backend no tiene la clave de DeepSeek. Cargala en backend/.env.", kind: "err" },
        );
      })
      .catch(() => {
        if (!vivo) return;
        setSalud("caido");
        setEstado({ msg: "No hay backend en el puerto 8000. El recorte funciona igual, la lectura no.", kind: "err" });
      });
    return () => { vivo = false; };
  }, []);

  async function procesar(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    try {
      setEstado({ msg: "Preprocesando…", kind: "go" });
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const gr = toGray(bmp);
      bmp.close();
      const gray8 = Uint8ClampedArray.from(gr.g);
      if (orig.current) paint(orig.current, gray8, gr.w, gr.h);

      const en = enhance(gr.g, gr.w, gr.h);
      const box = roi(en.find, gr.w, gr.h, en.thresh);
      if (proc.current) paint(proc.current, en.view, gr.w, gr.h, box);

      const send = crop(gr, box);
      setMedida({
        w: send.width,
        h: send.height,
        tok: Math.round((send.width * send.height) / 750),
        fullTok: Math.round((gr.w * gr.h) / 750),
      });

      if (salud === "caido") {
        setEstado({ msg: "Recorte listo. Levantá el backend para leer la pieza.", kind: "err" });
        return;
      }

      setEstado({ msg: "Leyendo la pieza con DeepSeek…", kind: "go" });
      const data = await leerPieza(await toJpeg(send));
      setLectura(data);
      setLecturaId(n => n + 1);
      setEstado({ msg: data.bloques.length ? "Leído — revisá y corregí si hace falta" : "Sin texto legible" });
    } catch (e) {
      setEstado({ msg: "No se pudo leer: " + (e instanceof Error ? e.message : String(e)), kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  const calcTok = medida?.tok ?? TYPICAL_TOK;
  const cut = medida && medida.fullTok > medida.tok ? Math.round((1 - medida.tok / medida.fullTok) * 100) : 0;
  const uso = lectura?.uso;
  const real = uso ? deepseekReal(uso.prompt_tokens ?? 0, uso.completion_tokens ?? 0) : null;

  const badge =
    salud === null ? { t: "comprobando…", live: false }
    : salud === "caido" ? { t: "backend apagado", live: false }
    : salud.clave_cargada ? { t: "DeepSeek · listo", live: true }
    : { t: "falta la clave", live: false };

  return (
    <>
      <header>
        <div className="wrap">
          <div>
            <h1>Lector de Piezas</h1>
            <p className="tagline">Códigos de troquel y sello sobre cerámica</p>
          </div>
          <span className={`badge${badge.live ? " live" : ""}`}>{badge.t}</span>
        </div>
      </header>

      <div className="wrap">
        <div className="cols">
          <section>
            <h2>1 · Capturar la pieza</h2>
            <div className="capture">
              <button className="btn primary" disabled={busy} onClick={() => camara.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M3 8h3l1.5-2h9L18 8h3v12H3z" /><circle cx="12" cy="13.5" r="3.6" />
                </svg>
                Tomar foto
              </button>
              <button className="btn" disabled={busy} onClick={() => galeria.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" /><path d="M3 17l5-5 3.5 3.5L16 10l5 5" />
                </svg>
                Subir archivo
              </button>
            </div>
            <input ref={camara} type="file" accept="image/*" capture="environment" hidden
              onChange={e => { procesar(e.target.files?.[0]); e.target.value = ""; }} />
            <input ref={galeria} type="file" accept="image/*" hidden
              onChange={e => { procesar(e.target.files?.[0]); e.target.value = ""; }} />

            <h2>2 · Preprocesado, acá mismo</h2>
            <div className="frames">
              <figure className="frame"><canvas ref={orig} width={4} height={3} /><figcaption>Original</figcaption></figure>
              <figure className="frame"><canvas ref={proc} width={4} height={3} /><figcaption>Relieve + tinta · recorte</figcaption></figure>
            </div>
            <p className="hint">
              El realce y el recorte corren en tu equipo, sin costo. Al modelo solo le llega el recorte, y eso es lo que abarata cada lectura.
            </p>

            <p className={`status ${estado.kind ?? ""}`} role="status">{estado.msg}</p>

            <h2>3 · Códigos leídos</h2>
            <div className="result">
              {!lectura && <p className="empty">Todavía no se leyó ninguna pieza.</p>}
              {lectura && lectura.bloques.length === 0 && <p className="empty">No se detectó texto legible en esta foto.</p>}
              {lectura?.bloques.map((b, i) => <Fila key={`${lecturaId}-${i}`} b={b} i={i} />)}
            </div>
            <p className="note">
              Los campos son editables: si la lectura sale mal, corregila a mano. El chip de la derecha valida el formato en el momento.
            </p>
          </section>

          <section>
            <div className="panel">
              <div className="panel-hd">
                <h2>Qué cuesta leer 10.000 piezas</h2>
                <span className="live-tok">
                  {uso ? `${(uso.prompt_tokens ?? 0).toLocaleString("es")} + ${(uso.completion_tokens ?? 0).toLocaleString("es")} tok reales`
                    : medida ? `${medida.tok.toLocaleString("es")} tok · imagen real` : "esperando foto"}
                </span>
              </div>
              <div className="tblwrap">
                <table>
                  <thead>
                    <tr><th>Motor</th><th className="r">Por imagen</th><th className="r">10.000</th></tr>
                  </thead>
                  <tbody>
                    {ENGINES.map(e => {
                      const c = costOf(e, calcTok);
                      const now = e.id === ENGINE_NOW;
                      return (
                        <tr key={e.id} className={now ? "now" : e.dead ? "dead" : ""}>
                          <td>
                            <span className="who">
                              {e.name}
                              {now && <span className="tag now">en uso</span>}
                              {e.dead && <span className="tag no">no sirve</span>}
                              <small>{e.sub}</small>
                            </span>
                          </td>
                          <td className="num">{money(c)}</td>
                          <td className="num big">{e.dead ? "—" : "$" + (c * 10000).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="note">
                {medida
                  ? <>Calculado sobre <b>{medida.tok.toLocaleString("es")} tokens</b> de la foto que acabás de procesar.</>
                  : <>Estimado sobre un recorte típico de <b>{TYPICAL_TOK} tokens</b>. Procesá una foto y la tabla se recalcula.</>}
              </p>
            </div>

            <div className="panel">
              <div className="panel-hd"><h2>Esta lectura en concreto</h2></div>
              <div className="kv">
                <div><b>{medida ? `${medida.w}×${medida.h}` : "—"}</b><small>px enviados</small></div>
                <div><b>{medida ? medida.tok.toLocaleString("es") : "—"}</b><small>tokens de imagen</small></div>
                <div><b className={cut > 3 ? "cut" : ""}>{medida ? `${cut}%` : "—"}</b><small>tokens ahorrados</small></div>
              </div>
              <p className="note">
                {real && uso ? (
                  <>
                    DeepSeek facturó <b>{(uso.prompt_tokens ?? 0).toLocaleString("es")} tokens de entrada</b> y{" "}
                    {(uso.completion_tokens ?? 0).toLocaleString("es")} de salida. A ese ritmo, 10.000 piezas cuestan{" "}
                    <b>${(real.off * 10000).toFixed(2)}</b> fuera de hora pico y ${(real.peak * 10000).toFixed(2)} en hora pico.
                  </>
                ) : medida ? (
                  cut > 3
                    ? <>Mandar la foto entera habría costado <b>{medida.fullTok.toLocaleString("es")} tokens</b>. El recorte bajó eso a {medida.tok.toLocaleString("es")}.</>
                    : <>La foto ya venía ajustada al texto, así que el recorte casi no cambió el tamaño.</>
                ) : (
                  <>Se calcula cuando proceses la primera foto.</>
                )}
              </p>
            </div>

            <div className="panel">
              <div className="panel-hd"><h2>Para usarlo desde otra PC</h2></div>
              <ol className="steps">
                <li>Publicá el backend y el frontend; los pasos están en el README del repo.</li>
                <li>Cargá <b>ACCESS_CODE</b> en el backend: sin él, cualquiera con el link gasta tu saldo.</li>
                <li>Funciona igual en celular y en PC. En celular, <b>Tomar foto</b> abre la cámara directo.</li>
              </ol>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
