# Guía de instalación

Cómo montar el Lector de Piezas en cualquier máquina: clonar, poner la clave y
levantar con Docker. Son unos diez minutos, la mayoría esperando que termine
la primera compilación.

## Qué hace falta

- **Git.**
- **Docker con Compose.** En Windows y Mac, [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  abierto. En Linux, Docker Engine con el plugin `docker compose`.
- **Una clave de API con saldo**, de DeepSeek o de OpenAI:
  - DeepSeek: [platform.deepseek.com](https://platform.deepseek.com)
  - OpenAI: [platform.openai.com](https://platform.openai.com)

  En los dos se crea la cuenta, se carga saldo (con USD 10 alcanza para
  decenas de miles de lecturas) y se crea la clave en la sección *API keys*.
  La muestran una sola vez: copiala en ese momento.

## 1. Clonar el repositorio

```bash
git clone https://github.com/marcado993/orc-gigix.git
cd orc-gigix
```

## 2. Crear el archivo `.env`

Copiá la plantilla. En Windows:

```bash
copy .env.example .env
```

En Linux o Mac:

```bash
cp .env.example .env
```

Abrí `.env` con cualquier editor y completalo:

```
DEEPSEEK_API_KEY=sk-la-clave-que-copiaste
OPENAI_API_KEY=
ACCESS_CODE=un-codigo-que-elijas
PUERTO=3000
```

| Variable | Para qué |
|---|---|
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY` | La clave del proveedor con el que se lee. Alcanza con una. Si las dejás vacías, la app arranca igual y pide la clave en **Ajustes**. |
| `ACCESS_CODE` | La app lo pide la primera vez que alguien lee una pieza. Si la app va a estar en internet, ponelo sí o sí: sin él, cualquiera con el link gasta tu saldo. En una red interna podés dejarlo vacío. |
| `PUERTO` | Dónde queda la app en esta máquina. Cambialo si el 3000 ya está ocupado. |

El `.env` no se sube al repositorio: queda solo en esta máquina.

## 3. Levantar

```bash
docker compose up -d --build
```

La primera vez tarda unos minutos, porque descarga las imágenes base y compila
la app. Las siguientes son casi instantáneas.

Para confirmar que quedó andando:

```bash
docker compose ps
```

Tienen que aparecer `backend` y `frontend`, con el backend en estado
`healthy`.

## 4. Usar

Abrí **http://localhost:3000** (o el puerto que hayas puesto en `PUERTO`).

Arriba a la derecha tiene que aparecer el proveedor y el modelo, por ejemplo
**DeepSeek · deepseek-flash**. Sacá o subí una foto de la pieza y los códigos
aparecen en los campos de abajo.

### Probar otro proveedor, modelo o clave

En el panel **Ajustes de lectura** se elige proveedor (DeepSeek u OpenAI) y
modelo, y se puede pegar una clave propia sin tocar el `.env`. Esa clave queda
guardada solo en ese navegador, y tiene prioridad sobre la del servidor.

Debajo, **Proyección** muestra cuánto cuestan N imágenes con el modelo
elegido, comparado con lo que se paga hoy. Para medir el ahorro del recorte con
la cuenta real, activá **Comparar con la foto entera** antes de leer una pieza:
hace una segunda lectura con la foto sin recortar y muestra los tokens que
cobró el proveedor en cada caso.

Desde otro equipo o un celular de la misma red, usá la IP de la máquina en vez
de `localhost`, por ejemplo `http://192.168.1.50:3000`. Si no abre, el
firewall de la máquina tiene que permitir ese puerto.

## Operación

| Para | Comando |
|---|---|
| Ver qué está pasando | `docker compose logs -f` |
| Actualizar a la última versión | `git pull` y después `docker compose up -d --build` |
| Aplicar un cambio en `.env` | `docker compose up -d` |
| Apagar | `docker compose down` |

Los contenedores se reinician solos si la máquina se reinicia, siempre que
Docker arranque con el sistema.

## Problemas frecuentes

| Qué ves | Qué hacer |
|---|---|
| `No hay clave de DeepSeek` (u OpenAI) | Cargala en **Ajustes**, o en el `.env` y después `docker compose up -d`. |
| `La clave de … es inválida` | La clave se copió mal o fue revocada. Creá otra en la consola del proveedor. |
| `La cuenta de … no tiene saldo` | Cargá saldo en la consola del proveedor. No hace falta reiniciar nada. |
| `… no reconoce el modelo` | Tu cuenta no tiene acceso a ese modelo. Elegí otro en **Ajustes**. |
| `port is already allocated` o, en Windows, `ports are not available` | Otro programa usa el puerto. Cambiá `PUERTO` en `.env` y volvé a levantar con `docker compose up -d`. |
| `Cannot connect to the Docker daemon` | Docker Desktop no está abierto. Abrilo y esperá a que termine de arrancar. |
| La app pide un código | Es el `ACCESS_CODE` del `.env`. Queda guardado en ese navegador. |

## Ponerla en internet

Tal como queda, la app escucha por HTTP en el puerto elegido. Para publicarla
en internet conviene ponerle adelante algo que agregue HTTPS (Caddy, Nginx o
un túnel de Cloudflare) y, sobre todo, completar `ACCESS_CODE`.
