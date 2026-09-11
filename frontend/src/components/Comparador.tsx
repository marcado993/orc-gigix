"use client";

import { useState } from "react";
import { type Bloque, leerPieza, type Uso } from "@/lib/api";
import { type Salud } from "@/lib/ajustes";
import { costoReal, engineDe, money } from "@/lib/costs";

/*
 * Compara modelos con datos reales: la MISMA foto va a cada modelo marcado, y
 * se mide lo que leyo, cuanto cobro de verdad y cuanto tardo. Con los codigos
 * correctos cargados, tambien cuantos acerto. El acumulado suma todas las
 * fotos comparadas, que es lo que sirve para decidir: una sola foto no alcanza.
 */

type Props = {
  salud: Salud;
  claves: Record<string, string>;
  recorte: Blob | null;
  /* cambia con cada foto procesada: el acumulado cuenta cada foto una vez */
  fotoId: number;
  cantidad: number;
};

type Opcion = { key: string; prov: string; modelo: string; provNombre: string };

type Resultado = Opcion & {
  ok: boolean;
  error?: string;
  bloques?: Bloque[];
  uso?: Uso;
  ms: number;
  costo: number | null;
  /* codigos correctos cargados al comparar; vacio si no se cargaron */
  verdad: string[];
};

/* Los mas baratos vigentes, mas los que conviene tener de referencia. */
const POR_DEFECTO = ["deepseek-flash", "gpt-5.6-luna", "gpt-5.4-nano", "gpt-5-nano", "gpt-4.1-nano"];

/* Espacios y guiones no cuentan: "T-5805" y "T5805" son la misma lectura. */
const norm = (s: string) => s.toUpperCase().replace(/[\s\-–]/g, "");

function parseVerdad(v: string): string[] {
  return v.split(/[\n,;]+/).map(norm).filter(Boolean);
}

function contar(bloques: Bloque[], esperados: string[]): number {
  const leidos = new Set(bloques.map(b => norm(b.texto)));
  return esperados.filter(e => leidos.has(e)).length;
}

function aciertosDe(r: Resultado): number | null {
  return r.ok && r.verdad.length ? contar(r.bloques ?? [], r.verdad) : null;
}

const dinero = (v: number) => (v >= 1 ? "$" + v.toFixed(2) : money(v));
const seg = (ms: number) => (ms / 1000).toFixed(1) + " s";

export default function Comparador({ salud, claves, recorte, fotoId, cantidad }: Props) {
  const opciones: Opcion[] = Object.entries(salud.proveedores).flatMap(([prov, p]) =>
    p.modelos.map(modelo => ({ key: `${prov}:${modelo}`, prov, modelo, provNombre: p.nombre })),
  );
  const tieneClave = (prov: string) => !!(claves[prov] || salud.proveedores[prov]?.clave_servidor);

  const [marcados, setMarcados] = useState<Set<string>>(
    () => new Set(opciones.filter(o => POR_DEFECTO.includes(o.modelo)).map(o => o.key)),
  );
  const [verdad, setVerdad] = useState("");
  const [corriendo, setCorriendo] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [ultima, setUltima] = useState<Resultado[]>([]);
  /* foto -> modelo -> resultado. Volver a comparar la misma foto reemplaza. */
  const [historial, setHistorial] = useState<Record<number, Record<string, Resultado>>>({});

  const elegibles = opciones.filter(o => marcados.has(o.key) && tieneClave(o.prov));

  function alternar(key: string) {
    setMarcados(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  async function correr() {
    if (!recorte || !elegibles.length) return;
    const esperados = parseVerdad(verdad);
    const res: Resultado[] = [];
    setCorriendo(true);
    setUltima([]);
    /* En serie, no en paralelo: evita choques con el limite de pedidos y deja
       medir cuanto tarda cada modelo sin que se pisen. */
    for (let i = 0; i < elegibles.length; i++) {
      const o = elegibles[i];
      setProgreso(`${i + 1} de ${elegibles.length} · ${o.modelo}`);
      const t0 = performance.now();
      try {
        const l = await leerPieza(recorte, o.prov, o.modelo, claves[o.prov]);
        const uso = l.uso ?? {};
        const c = costoReal(o.modelo, uso.prompt_tokens ?? 0, uso.completion_tokens ?? 0);
        res.push({
          ...o, ok: true, bloques: l.bloques, uso, ms: performance.now() - t0,
          costo: c ? c.base : null, verdad: esperados,
        });
      } catch (e) {
        res.push({
          ...o, ok: false, error: e instanceof Error ? e.message : String(e),
          ms: performance.now() - t0, costo: null, verdad: esperados,
        });
      }
      setUltima([...res]);
    }
    setHistorial(h => ({ ...h, [fotoId]: { ...h[fotoId], ...Object.fromEntries(res.map(r => [r.key, r])) } }));
    setProgreso("");
    setCorriendo(false);
  }

  const ordenar = (a: Resultado, b: Resultado) =>
    Number(b.ok) - Number(a.ok) || (aciertosDe(b) ?? -1) - (aciertosDe(a) ?? -1) || (a.costo ?? 1) - (b.costo ?? 1);
  const filasUltima = [...ultima].sort(ordenar);
  /* El que mas acerto; entre empatados, el mas barato. */
  const mejor = filasUltima.find(r => r.ok);
  /* El mas barato de todos los que respondieron, acierte o no. */
  const masBarato = [...ultima].filter(r => r.ok && r.costo !== null).sort((a, b) => (a.costo ?? 0) - (b.costo ?? 0))[0];

  const fotos = Object.values(historial);
  /* Acumulado por modelo, sobre todas las fotos comparadas. */
  const acum = new Map<string, { o: Opcion; fotos: number; aciertos: number; esperados: number; costo: number; nCosto: number; ms: number; nMs: number; errores: number }>();
  for (const porModelo of fotos) {
    for (const r of Object.values(porModelo)) {
      const a = acum.get(r.key) ?? { o: r, fotos: 0, aciertos: 0, esperados: 0, costo: 0, nCosto: 0, ms: 0, nMs: 0, errores: 0 };
      a.fotos++;
      if (!r.ok) { a.errores++; acum.set(r.key, a); continue; }
      a.ms += r.ms;
      a.nMs++;
      const ac = aciertosDe(r);
      if (ac !== null) { a.aciertos += ac; a.esperados += r.verdad.length; }
      if (r.costo !== null) { a.costo += r.costo; a.nCosto++; }
      acum.set(r.key, a);
    }
  }
  const filasAcum = [...acum.values()].sort((a, b) => {
    const pa = a.esperados ? a.aciertos / a.esperados : -1, pb = b.esperados ? b.aciertos / b.esperados : -1;
    return pb - pa || (a.nCosto ? a.costo / a.nCosto : 1) - (b.nCosto ? b.costo / b.nCosto : 1);
  });

  const hayVerdad = ultima.some(r => r.verdad.length > 0);
  const aMejor = mejor ? aciertosDe(mejor) : null;
  const aBarato = masBarato ? aciertosDe(masBarato) : null;

  return (
    <div className="panel wide">
      <div className="panel-hd">
        <h2>Comparar modelos con la misma foto</h2>
        {fotos.length > 0 && <span className="live-tok">{fotos.length} foto{fotos.length > 1 ? "s" : ""} comparada{fotos.length > 1 ? "s" : ""}</span>}
      </div>

      <div className="cmp-grid">
        <div>
          <span className="rl">Modelos</span>
          <div className="models">
            {opciones.map(o => {
              const e = engineDe(o.modelo);
              const sinClave = !tieneClave(o.prov);
              return (
                <label key={o.key} className={`model${sinClave ? " off" : ""}`}>
                  <input type="checkbox" checked={marcados.has(o.key)} onChange={() => alternar(o.key)} disabled={sinClave} />
                  <span>
                    <b>{o.modelo}</b>
                    <small>{sinClave ? `falta clave de ${o.provNombre}` : e?.sub ?? o.provNombre}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div>
          <label>
            <span className="rl">Códigos correctos de esta foto (uno por línea)</span>
            <textarea
              rows={4}
              value={verdad}
              onChange={e => setVerdad(e.target.value)}
              placeholder={"0905 76 08 30\n6510426090\nT-5805"}
              spellCheck={false}
            />
          </label>
          <p className="note tight">Opcional, pero sin esto solo se comparan costo y velocidad, no si leyó bien.</p>
          <button className="btn primary" disabled={!recorte || !elegibles.length || corriendo} onClick={correr}>
            {corriendo ? progreso : `Comparar ${elegibles.length} modelo${elegibles.length === 1 ? "" : "s"}`}
          </button>
          {!recorte && <p className="note tight">Primero sacá o subí una foto: se compara sobre ese recorte.</p>}
          {recorte && <p className="note tight">Cada modelo es una lectura aparte y se cobra por separado.</p>}
        </div>
      </div>

      {filasUltima.length > 0 && (
        <>
          <p className="verdict-line">
            {mejor ? (
              hayVerdad && aMejor !== null ? (
                <>
                  Con esta foto, el que más acertó fue <b>{mejor.modelo}</b>: {aMejor} de {mejor.verdad.length}
                  {mejor.costo !== null && <>, <b>{dinero(mejor.costo * cantidad)}</b> por {cantidad.toLocaleString("es")} imágenes</>}.
                  {masBarato && masBarato.key !== mejor.key && aBarato !== null && aBarato < aMejor && masBarato.costo !== null && (
                    <> {masBarato.modelo} sale más barato ({dinero(masBarato.costo * cantidad)}) pero acertó {aBarato} de {masBarato.verdad.length}.</>
                  )}
                </>
              ) : (
                <>El más barato que respondió fue <b>{mejor.modelo}</b>
                {mejor.costo !== null && <>: <b>{dinero(mejor.costo * cantidad)}</b> por {cantidad.toLocaleString("es")} imágenes</>}.
                Cargá los códigos correctos para saber cuál leyó bien.</>
              )
            ) : (
              <>Ningún modelo respondió. Revisá los errores de la tabla.</>
            )}
          </p>
          <div className="tblwrap">
            <table className="cmp">
              <thead>
                <tr>
                  <th>Modelo</th><th>Leyó</th>{hayVerdad && <th className="r">Aciertos</th>}
                  <th className="r">Tok entrada / salida</th><th className="r">Por foto</th>
                  <th className="r">{cantidad.toLocaleString("es")}</th><th className="r">Tiempo</th>
                </tr>
              </thead>
              <tbody>
                {filasUltima.map(r => {
                  const esperados = new Set(r.verdad);
                  const ac = aciertosDe(r);
                  return (
                    <tr key={r.key} className={r === mejor ? "now" : !r.ok ? "dead" : ""}>
                      <td><span className="who">{r.modelo}<small>{r.provNombre}</small></span></td>
                      <td className="leido">
                        {r.ok
                          ? r.bloques?.length
                            ? r.bloques.map((b, i) => (
                              <span key={i} className={`code${r.verdad.length ? (esperados.has(norm(b.texto)) ? " ok" : " bad") : ""}`}>{b.texto}</span>
                            ))
                            : <span className="muted">nada</span>
                          : <span className="err">{r.error}</span>}
                      </td>
                      {hayVerdad && <td className="num">{ac !== null ? `${ac}/${r.verdad.length}` : "—"}</td>}
                      <td className="num">{r.uso ? `${(r.uso.prompt_tokens ?? 0).toLocaleString("es")} / ${(r.uso.completion_tokens ?? 0).toLocaleString("es")}` : "—"}</td>
                      <td className="num">{r.costo !== null ? money(r.costo) : "—"}</td>
                      <td className="num big">{r.costo !== null ? dinero(r.costo * cantidad) : "—"}</td>
                      <td className="num">{seg(r.ms)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {fotos.length > 1 && (
        <>
          <h3 className="sub">Acumulado de {fotos.length} fotos</h3>
          <div className="tblwrap">
            <table>
              <thead>
                <tr><th>Modelo</th><th className="r">Aciertos</th><th className="r">Por foto (prom.)</th><th className="r">{cantidad.toLocaleString("es")}</th><th className="r">Tiempo prom.</th><th className="r">Errores</th></tr>
              </thead>
              <tbody>
                {filasAcum.map((a, i) => {
                  const prom = a.nCosto ? a.costo / a.nCosto : null;
                  return (
                    <tr key={a.o.key} className={i === 0 ? "now" : ""}>
                      <td><span className="who">{a.o.modelo}<small>{a.fotos} foto{a.fotos > 1 ? "s" : ""}</small></span></td>
                      <td className="num">{a.esperados ? `${a.aciertos}/${a.esperados} · ${Math.round((a.aciertos / a.esperados) * 100)}%` : "—"}</td>
                      <td className="num">{prom !== null ? money(prom) : "—"}</td>
                      <td className="num big">{prom !== null ? dinero(prom * cantidad) : "—"}</td>
                      <td className="num">{a.nMs ? seg(a.ms / a.nMs) : "—"}</td>
                      <td className="num">{a.errores || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="note">
        {fotos.length > 0 && (
          <button className="linkbtn" onClick={() => { setHistorial({}); setUltima([]); }}>Reiniciar comparación</button>
        )}{" "}
        Una foto no alcanza para decidir: repetí con 20 a 30 piezas distintas, cargando sus códigos correctos, y mirá el
        acumulado. En los GPT-5 los tokens de salida incluyen lo que el modelo razonó antes de responder, y se cobran.
      </p>
    </div>
  );
}
