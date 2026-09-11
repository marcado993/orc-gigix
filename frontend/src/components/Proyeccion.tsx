"use client";

import { costoReal, type Engine, type Medidas, money, porCentavo, proyectar } from "@/lib/costs";

export type Uso = { prompt_tokens?: number; completion_tokens?: number };

type Props = {
  engine: Engine | undefined;
  modelo: string;
  recorte: Medidas;
  entera: Medidas;
  deFotoReal: boolean;
  cantidad: number;
  onCantidad: (n: number) => void;
  /* lo que la empresa paga hoy por imagen */
  hoy: number;
  onHoy: (v: number) => void;
  usoRecorte: Uso | null;
  usoEntera: Uso | null;
};

const fmt = (n: number) => n.toLocaleString("es");
const dinero = (v: number) => (v >= 1 ? "$" + v.toFixed(2) : money(v));

/* Por que el recorte no cambia el costo en algunos modelos. */
function motivoSinAhorro(e: Engine): string {
  if (e.id.startsWith("ds")) return "DeepSeek cobra hasta 1.024 tokens por imagen, sea del tamaño que sea";
  if (e.id === "4o" || e.id === "4omini") return `${e.name} achica cualquier foto al mismo tamaño y la cobra por mosaicos de 512 px`;
  return "este modelo cobra casi lo mismo por cualquier imagen";
}

export default function Proyeccion(p: Props) {
  if (!p.engine) return null;
  const e = p.engine;
  const est = proyectar(e, p.recorte, p.entera, p.cantidad);
  const hayAhorro = est.pct >= 5;
  const totalHoy = p.hoy * p.cantidad;
  const porModelo = totalHoy - est.totalEnt;

  const realRec = p.usoRecorte ? costoReal(p.modelo, p.usoRecorte.prompt_tokens ?? 0, p.usoRecorte.completion_tokens ?? 0) : null;
  const realEnt = p.usoEntera ? costoReal(p.modelo, p.usoEntera.prompt_tokens ?? 0, p.usoEntera.completion_tokens ?? 0) : null;
  const pctReal = realRec && realEnt && realEnt.base > 0 ? Math.round((1 - realRec.base / realEnt.base) * 100) : null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>Proyección · {e.name}</h2>
      </div>

      <div className="qtys">
        <label className="qty">
          <span className="rl">Cantidad de imágenes</span>
          <input
            type="number"
            min={1}
            step={1000}
            value={p.cantidad}
            onChange={ev => p.onCantidad(Math.max(1, Math.round(Number(ev.target.value) || 1)))}
          />
        </label>
        <label className="qty">
          <span className="rl">Hoy pagan por imagen (USD)</span>
          <input
            type="number"
            min={0}
            step={0.001}
            value={p.hoy}
            onChange={ev => p.onHoy(Math.max(0, Number(ev.target.value) || 0))}
          />
        </label>
      </div>

      <div className="versus three">
        <div className="side">
          <span className="rl">Hoy</span>
          <b>{dinero(totalHoy)}</b>
          <small>{porCentavo(p.hoy)} imágenes por centavo</small>
        </div>
        <div className="side">
          <span className="rl">{e.name}, foto entera</span>
          <b>{dinero(est.totalEnt)}</b>
          <small>{fmt(est.tokEnt)} tok de imagen · {money(est.porImgEnt)} por foto</small>
        </div>
        <div className="side win">
          <span className="rl">{e.name} + la app</span>
          <b>{dinero(est.totalRec)}</b>
          <small>{fmt(est.tokRec)} tok de imagen · {porCentavo(est.porImgRec)} imágenes por centavo</small>
        </div>
      </div>

      <p className="verdict-line">
        {totalHoy > est.totalRec ? (
          <>
            De <b>{dinero(totalHoy)}</b> a <b>{dinero(est.totalRec)}</b> en {fmt(p.cantidad)} imágenes:{" "}
            <b>{Math.round((1 - est.totalRec / totalHoy) * 100)}% menos</b>.{" "}
            {porModelo > 0 && <>Cambiar de modelo ahorra {dinero(porModelo)}</>}
            {porModelo > 0 && hayAhorro && <>; </>}
            {hayAhorro && <>el recorte de la app ahorra {dinero(est.totalEnt - est.totalRec)} más ({est.pct}% sobre la foto entera)</>}
            {(porModelo > 0 || hayAhorro) && <>.</>}
          </>
        ) : (
          <>Con estos valores, {e.name} no baja lo que pagan hoy.</>
        )}{" "}
        {!hayAhorro && <>Con {e.name} el recorte casi no cambia el costo: {motivoSinAhorro(e)}. Sirve igual, porque el texto ocupa más de la imagen que ve el modelo y se lee mejor.</>}
      </p>

      {realRec && (
        <div className="tblwrap">
          <table>
            <thead>
              <tr><th>Medido con tu cuenta</th><th className="r">Tok entrada</th><th className="r">Por foto</th><th className="r">{fmt(p.cantidad)} fotos</th></tr>
            </thead>
            <tbody>
              <tr className="now">
                <td><span className="who">Recorte de la app</span></td>
                <td className="num">{fmt(p.usoRecorte?.prompt_tokens ?? 0)}</td>
                <td className="num">{money(realRec.base)}</td>
                <td className="num big">{dinero(realRec.base * p.cantidad)}</td>
              </tr>
              {realEnt && (
                <tr>
                  <td><span className="who">Foto entera</span></td>
                  <td className="num">{fmt(p.usoEntera?.prompt_tokens ?? 0)}</td>
                  <td className="num">{money(realEnt.base)}</td>
                  <td className="num big">{dinero(realEnt.base * p.cantidad)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="note">
        {pctReal !== null ? (
          <>Medido de verdad: el recorte cobró <b>{pctReal}% {pctReal >= 0 ? "menos" : "más"}</b> que la foto entera.{" "}</>
        ) : null}
        {realRec?.pico != null && <>DeepSeek en hora pico cuesta el doble. </>}
        {realRec
          ? !realEnt && <>Para medir el ahorro real, activá <b>Comparar con la foto entera</b> y leé otra pieza.</>
          : <>Estimado con la regla de tokens de imagen que publica cada proveedor
            {p.deFotoReal ? ", sobre tu foto" : ", sobre un recorte típico y una foto de celular de 12 MP"}.
            Al leer una pieza aparecen los tokens que cobró de verdad.</>}
      </p>
    </div>
  );
}
