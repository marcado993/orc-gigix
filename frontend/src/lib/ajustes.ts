/*
 * Ajustes de lectura que el usuario elige en la app: proveedor, modelo y,
 * opcionalmente, su propia clave para probar sin tocar el servidor.
 *
 * Quedan en el localStorage de ESTE navegador. La clave viaja al backend en
 * cada lectura y el backend no la guarda. Hay una clave por proveedor, asi se
 * puede alternar entre DeepSeek y OpenAI sin volver a pegarlas.
 */

export type Proveedor = {
  nombre: string;
  modelos: string[];
  consola: string;
  clave_servidor: boolean;
};

export type Salud = {
  ok: boolean;
  proveedor_defecto: string;
  codigo_requerido: boolean;
  proveedores: Record<string, Proveedor>;
};

export type Ajustes = {
  proveedor: string;
  modelo: string;
  claves: Record<string, string>;
};

const KEY = "lectorAjustes";

export function cargarAjustes(salud: Salud): Ajustes {
  let guardado: Partial<Ajustes> = {};
  try {
    guardado = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    /* almacenamiento bloqueado o corrupto: se usan los valores por defecto */
  }
  const proveedor = guardado.proveedor && salud.proveedores[guardado.proveedor]
    ? guardado.proveedor
    : salud.proveedor_defecto;
  const modelos = salud.proveedores[proveedor]?.modelos ?? [];
  const modelo = guardado.modelo && modelos.includes(guardado.modelo) ? guardado.modelo : modelos[0] ?? "";
  return { proveedor, modelo, claves: guardado.claves ?? {} };
}

export function guardarAjustes(a: Ajustes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* sin almacenamiento: los ajustes duran lo que dure la pagina abierta */
  }
}

export function ocultar(clave: string): string {
  return clave.length > 8 ? "…" + clave.slice(-4) : "cargada";
}
