"use client";

import { useState } from "react";
import { type Ajustes, ocultar, type Salud } from "@/lib/ajustes";

type Props = {
  salud: Salud;
  ajustes: Ajustes;
  onChange: (a: Ajustes) => void;
};

export default function PanelAjustes({ salud, ajustes, onChange }: Props) {
  const [borrador, setBorrador] = useState("");
  const prov = salud.proveedores[ajustes.proveedor];
  const propia = ajustes.claves[ajustes.proveedor] ?? "";

  function cambiarProveedor(p: string) {
    onChange({ ...ajustes, proveedor: p, modelo: salud.proveedores[p].modelos[0] });
    setBorrador("");
  }

  function guardarClave() {
    const c = borrador.trim();
    if (!c) return;
    onChange({ ...ajustes, claves: { ...ajustes.claves, [ajustes.proveedor]: c } });
    setBorrador("");
  }

  function borrarClave() {
    const claves = { ...ajustes.claves };
    delete claves[ajustes.proveedor];
    onChange({ ...ajustes, claves });
  }

  const origen = propia
    ? { cls: "ok", txt: `Usando tu clave (${ocultar(propia)})` }
    : prov.clave_servidor
      ? { cls: "ok", txt: "Usando la clave del servidor" }
      : { cls: "bad", txt: "Sin clave: pegá una abajo" };

  return (
    <div className="panel">
      <div className="panel-hd"><h2>Ajustes de lectura</h2></div>
      <div className="form">
        <label>
          <span className="rl">Proveedor</span>
          <select value={ajustes.proveedor} onChange={e => cambiarProveedor(e.target.value)}>
            {Object.entries(salud.proveedores).map(([id, p]) => (
              <option key={id} value={id}>{p.nombre}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="rl">Modelo</span>
          <select value={ajustes.modelo} onChange={e => onChange({ ...ajustes, modelo: e.target.value })}>
            {prov.modelos.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>

        <div className="full">
          <span className="rl">Clave de API de {prov.nombre}</span>
          <div className="keyrow">
            <input
              type="password"
              value={borrador}
              onChange={e => setBorrador(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") guardarClave(); }}
              placeholder={propia ? "pegá otra para reemplazarla" : "sk-…"}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn sm" onClick={guardarClave} disabled={!borrador.trim()}>Guardar</button>
            {propia && <button className="btn sm" onClick={borrarClave}>Borrar</button>}
          </div>
          <p className={`keystate ${origen.cls}`}>{origen.txt}</p>
        </div>
      </div>
      <p className="note">
        Tu clave queda guardada solo en este navegador y viaja a tu servidor en cada lectura; el servidor no la
        guarda. No la cargues en una PC compartida. Se consigue en <b>{prov.consola}</b>.
      </p>
    </div>
  );
}
