"use client";

import { useEffect, useRef, useState } from "react";
import { crop, enhance, fotoEntera, paint, roi, toGray, toJpeg } from "@/lib/preprocess";
import { costOf, ENGINES, FOTO_TIPICA, type Medidas, money, porCentavo, TYPICAL } from "@/lib/costs";
import { type Ajustes, cargarAjustes, guardarAjustes, type Salud } from "@/lib/ajustes";
import { validate } from "@/lib/validate";
import PanelAjustes from "./PanelAjustes";
import Proyeccion, { type Uso } from "./Proyeccion";

type Bloque = { texto: string; tipo: "grabado" | "tinta"; confianza: "alta" | "media" | "baja" };
type Lectura = { bloques: Bloque[]; proveedor: string; modelo: string; uso: Uso | null };
type Estado = { msg: string; kind?: "err" | "go" };

const CODE_KEY = "codigoAcceso";

function leerCodigo(): string {
  try { return localStorage.getItem(CODE_KEY) ?? ""; } catch { return ""; }
}
function guardarCodigo(c: string) {
  try { localStorage.setItem(CODE_KEY, c); } catch { /* sin almacenamiento: se vuelve a pedir */ }
}

/* El prompt vive en el backend: desde aca viajan la imagen y los ajustes. */
async function leerPieza(blob: Blob, a: Ajustes, retry = true): Promise<Lectura> {
  const fd = new FormData();
  fd.append("archivo", blob, "pieza.jpg");
  const headers: Record<string, string> = { "x-proveedor": a.proveedor, "x-modelo": a.modelo };
  const code = leerCodigo();
  if (code) headers["x-codigo"] = code;
  const clave = a.claves[a.proveedor];
  if (clave) headers["x-api-key"] = clave;

  const r = await fetch("/api/leer", { method: "POST", body: fd, headers });
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
      return leerPieza(blob, a, false);
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
        <input value={valor} onChange={e => setValor(e.target.value)} spellCheck={false} aria-label={`Código leído ${i + 1}`} />
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
  const [ajustes, setAjustes] = useState<Ajustes | null>(null);
  const [estado, setEstado] = useState<Estado>({ msg: "Comprobando el backend…" });
  const [busy, setBusy] = useState(false);
  const [lectura, setLectura] = useState<Lectura | null>(null);
  const [lecturaEntera, setLecturaEntera] = useState<Lectura | null>(null);
  const [lecturaId, setLecturaId] = useState(0);
  const [recorte, setRecorte] = useState<Medidas | null>(null);
  const [entera, setEntera] = useState<Medidas | null>(null);
  const [comparar, setComparar] = useState(false);
  const [cantidad, setCantidad] = useState(20000);
  const [hoy, setHoy] = useState(0.005); // 2 imagenes por centavo

  useEffect(() => {
    let vivo = true;
    fetch("/api/salud")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: Salud) => {
        if (!vivo) return;
        setSalud(s);
        setAjustes(cargarAjustes(s));
        setEstado({ msg: "Listo: sacá o subí una foto de la pieza." });
      })
      .catch(() => {
        if (!vivo) return;
        setSalud("caido");
        setEstado({ msg: "No hay backend en el puerto 8000. El recorte funciona igual, la lectura no.", kind: "err" });
      });
    return () => { vivo = false; };
  }, []);

  function cambiarAjustes(a: Ajustes) {
    setAjustes(a);
    guardarAjustes(a);
  }

  async function procesar(file: File | undefined) {
    if (!file || busy) return;
    setBusy(true);
    setLecturaEntera(null);
    try {
      setEstado({ msg: "Preprocesando…", kind: "go" });
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const gr = toGray(bmp);
      if (orig.current) paint(orig.current, Uint8ClampedArray.from(gr.g), gr.w, gr.h);

      const en = enhance(gr.g, gr.w, gr.h);
      const box = roi(en.find, gr.w, gr.h, en.thresh);
      if (proc.current) paint(proc.current, en.view, gr.w, gr.h, box);

      const send = crop(bmp, gr, box);
      const full = comparar ? fotoEntera(bmp) : null;
      setRecorte({ w: send.width, h: send.height });
      setEntera({ w: bmp.width, h: bmp.height });
      bmp.close();

      if (salud === "caido" || !ajustes) {
        setEstado({ msg: "Recorte listo. Levantá el backend para leer la pieza.", kind: "err" });
        return;
      }

      setEstado({ msg: `Leyendo la pieza con ${ajustes.modelo}…`, kind: "go" });
      const data = await leerPieza(await toJpeg(send), ajustes);
      setLectura(data);
      setLecturaId(n => n + 1);

      if (full) {
        setEstado({ msg: "Leyendo también la foto entera, para comparar…", kind: "go" });
        setLecturaEntera(await leerPieza(await toJpeg(full), ajustes));
      }
      setEstado({ msg: data.bloques.length ? "Leído — revisá y corregí si hace falta" : "Sin texto legible" });
    } catch (e) {
      setEstado({ msg: "No se pudo leer: " + (e instanceof Error ? e.message : String(e)), kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  const med = recorte ?? TYPICAL;
  const ent = entera ?? FOTO_TIPICA;
  const seleccionado = ajustes ? ENGINES.find(e => e.modelo === ajustes.modelo) : undefined;
  const filas = ENGINES.map(e => ({ e, c: costOf(e, med.w, med.h) })).sort((a, b) => a.c - b.c);

  const prov = salud && salud !== "caido" && ajustes ? salud.proveedores[ajustes.proveedor] : null;
  const tieneClave = !!(prov && ajustes && (prov.clave_servidor || ajustes.claves[ajustes.proveedor]));
  const badge =
    salud === null ? { t: "comprobando…", live: false }
    : salud === "caido" ? { t: "backend apagado", live: false }
    : !ajustes || !prov ? { t: "…", live: false }
    : { t: tieneClave ? `${prov.nombre} · ${ajustes.modelo}` : `${prov.nombre} · falta la clave`, live: tieneClave };

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
            <label className="check">
              <input type="checkbox" checked={comparar} onChange={e => setComparar(e.target.checked)} />
              <span>Comparar con la foto entera <small>— hace una segunda lectura: esa foto cuesta el doble</small></span>
            </label>

            <h2>2 · Preprocesado, acá mismo</h2>
            <div className="frames">
              <figure className="frame"><canvas ref={orig} width={4} height={3} /><figcaption>Original</figcaption></figure>
              <figure className="frame"><canvas ref={proc} width={4} height={3} /><figcaption>Relieve + tinta · recorte</figcaption></figure>
            </div>
            <p className="hint">
              El realce y el recorte corren en tu equipo, sin costo. Al modelo solo le llega el recorte.
            </p>

            <p className={`status ${estado.kind ?? ""}`} role="status">{estado.msg}</p>

            <h2>3 · Códigos leídos</h2>
            <div className="result">
              {!lectura && <p className="empty">Todavía no se leyó ninguna pieza.</p>}
              {lectura && lectura.bloques.length === 0 && <p className="empty">No se detectó texto legible en esta foto.</p>}
              {lectura?.bloques.map((b, i) => <Fila key={`${lecturaId}-${i}`} b={b} i={i} />)}
            </div>
            {lectura && (
              <p className="note">Leído con <b>{lectura.modelo}</b>. Los campos son editables: si la lectura sale mal, corregila a mano.</p>
            )}

            {lecturaEntera && (
              <>
                <h2>Con la foto entera leyó</h2>
                <div className="result compare">
                  {lecturaEntera.bloques.length === 0 && <p className="empty">Nada legible.</p>}
                  {lecturaEntera.bloques.map((b, i) => (
                    <div className="row" key={i}>
                      <div>
                        <span className="rl">{b.tipo === "tinta" ? "Sellado en tinta" : "Grabado en relieve"} · confianza {b.confianza}</span>
                        <span className="mono">{b.texto}</span>
                      </div>
                      <span className={`chip ${validate(b.texto).cls}`}>{validate(b.texto).txt}</span>
                    </div>
                  ))}
                </div>
                <p className="note">Compará los dos resultados: además del costo, importa cuál leyó mejor.</p>
              </>
            )}
          </section>

          <section>
            {salud && salud !== "caido" && ajustes && (
              <PanelAjustes salud={salud} ajustes={ajustes} onChange={cambiarAjustes} />
            )}

            {ajustes && (
              <Proyeccion
                engine={seleccionado}
                modelo={ajustes.modelo}
                recorte={med}
                entera={ent}
                deFotoReal={!!recorte}
                cantidad={cantidad}
                onCantidad={setCantidad}
                hoy={hoy}
                onHoy={setHoy}
                usoRecorte={lectura?.uso ?? null}
                usoEntera={lecturaEntera?.uso ?? null}
              />
            )}

            <div className="panel">
              <div className="panel-hd">
                <h2>Todos los motores, sobre este recorte</h2>
                <span className="live-tok">{med.w}×{med.h} px</span>
              </div>
              <div className="tblwrap">
                <table>
                  <thead>
                    <tr><th>Motor</th><th className="r">Por imagen</th><th className="r">Img / centavo</th><th className="r">{cantidad.toLocaleString("es")}</th></tr>
                  </thead>
                  <tbody>
                    {filas.map(({ e, c }) => {
                      const now = !!seleccionado && e.id === seleccionado.id;
                      return (
                        <tr key={e.id} className={now ? "now" : e.dead ? "dead" : ""}>
                          <td>
                            <span className="who">
                              {e.name}
                              {now && <span className="tag now">elegido</span>}
                              {e.dead && <span className="tag no">no sirve</span>}
                              <small>{e.sub}</small>
                            </span>
                          </td>
                          <td className="num">{money(c)}</td>
                          <td className="num">{e.dead ? "—" : porCentavo(c)}</td>
                          <td className="num big">{e.dead ? "—" : "$" + (c * cantidad).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="note">
                Ordenado de más barato a más caro con la regla de tokens de imagen de cada proveedor. DeepSeek va al tope
                de su rango porque no publica su fórmula.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
