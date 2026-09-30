# Operar Vigía

Cómo correr Vigía como un servicio: en el equipo de una persona (modo local) o como espejo público de solo lectura
para una institución (modo público). Todo lo que se describe aquí está probado; las cifras medidas están en
`docs/PERF.md`.

## Los dos modos

| | Local (por defecto) | Público (`--public` o `VIGIA_MODE=public`) |
|---|---|---|
| Para quién | Una persona en su equipo | Una institución que publica un espejo para todos |
| Escrituras (claves, ajustes, fuentes, IA) | Solo desde este equipo, mismo origen y con la cookie del enlace de la terminal | **Desactivadas por completo**, con o sin cookie (`403`) |
| Enlace con token en la terminal | Sí | No se imprime ni se acepta |
| Cabecera `Host` | Solo `localhost` (o la red local con `--host 0.0.0.0`) | Cualquiera (detrás de un proxy inverso) |
| CORS en `/api/v1` | Apagado (se activa con `VIGIA_CORS=1`) | Encendido: `*`, solo GET/HEAD/OPTIONS, nunca con credenciales |
| Claves | Desde la guía `/guia` o variables de entorno | Solo variables de entorno |
| Abre el navegador | Sí (salvo `--no-open`) | Nunca |

En modo público nadie puede cambiar nada desde un navegador: no hay sesión que robar ni ajuste que alterar. Las
claves (todas opcionales; sin ninguna funcionan las fuentes abiertas) se pasan como variables de entorno
(`NASA_FIRMS_MAP_KEY=…`; ver `.env.example`).

**Por qué CORS está apagado en modo local:** con CORS abierto, cualquier página web que la persona visite podría
leer su Vigía local y saber que lo usa. En un equipo en Venezuela eso importa. Un espejo público no tiene ese
riesgo: sus datos ya son públicos.

## Configuración

Se valida al arrancar; un valor inválido detiene Vigía con un mensaje claro en español y código de salida 2
(por ejemplo `Configuración no válida: El modo (--mode o VIGIA_MODE) debe ser «local» o «public» (recibido: «x»).`).
Las opciones de la línea de comandos ganan a las variables de entorno.

| Opción | Variable | Valores | Por defecto |
|---|---|---|---|
| `--public`, `--mode <m>` | `VIGIA_MODE` | `local`, `public` | `local` |
| `--port <n>` | `VIGIA_PORT` | 1–65535 | `7722` |
| `--host <dir>` | `VIGIA_HOST` | dirección de escucha | `127.0.0.1` |
| `--cors` | `VIGIA_CORS` | `1`/`0` | `0` en local, `1` en público |
| `--metrics <m>` | `VIGIA_METRICS` | `off`, `loopback`, `open` | `loopback` |
| `--log json` | `VIGIA_LOG_FORMAT` | `text`, `json` | `text` |
| `--trust-proxy` | `VIGIA_TRUST_PROXY` | `1` (proxy en este equipo), o lista de direcciones y rangos IPv4 (`172.16.0.0/12,10.0.0.2`) | ninguno |
| `--no-fetch` | `VIGIA_NO_FETCH` | `1`/`0` | `0` |
| `--no-open` | `VIGIA_NO_OPEN` | `1`/`0` | `0` |
| | `VIGIA_BCV_API` | `1`/`0` (`off` también vale) | `1`: la fuente `bcv-api` está activa |
| `--no-crowd` | `VIGIA_CROWD` | `1`/`0` | `1`: los reportes de usuarios están activos |
| `--data-saver` | `VIGIA_DATA_SAVER` | `1`/`0` | sin fijar: lo decide la persona en la página (apagado hasta que elija) |
| | `VIGIA_FFMPEG` | ruta a ffmpeg, o `0` | el `ffmpeg` del `PATH`, si hay uno (solo para los cuadros de TV) |
| | `VIGIA_HOME` | carpeta de datos y ajustes | según el sistema (`vigia paths`) |

**`bcv-api`** es la segunda vía a la tasa oficial: un servicio público del mantenedor de Vigía
(github.com/elberacasa/bcv-api) que lee bcv.org.ve. Está activa por defecto en toda instalación, espejos públicos
incluidos (decisión del dueño, 2026-09-25): es una lectura GET de un punto público, sin claves y sin enviar ningún
dato del usuario ni de los visitantes. Quien prefiera no usarla la apaga con `VIGIA_BCV_API=0` (gana a config.json)
o con el interruptor de la fuente en /fuentes; la tasa sigue llegando por la vía directa (bcv.org.ve).

**Conexión limitada** (`--data-saver`, `VIGIA_DATA_SAVER=1`): apaga las fuentes pesadas, las que descargan 20 MB
al día o más según la medición de cada fuente (`docs/PERF.md`, «Daily download per feed»; hoy 8: cuadros de TV,
satélite GOES, comprobación en vivo de YouTube, cámaras públicas, rayos GLM, sondeo de canales IPTV, incendios sin
clave y sondeo de radios). Con todo encendido Vigía descarga unos 1.175 MB al día; con la conexión limitada, unos
255. Sin la opción, en un Vigía personal la página pregunta una vez «¿Tu conexión es limitada?» y la persona lo
cambia luego en Personalizar › Mis fuentes o en `/guia`; con la opción (1 o 0) la página muestra el valor fijado y
no lo puede cambiar. El interruptor propio de cada fuente siempre gana. **En un espejo público queda apagada salvo
que su operador la active**: el ancho de banda es del servidor, no de los visitantes, cuyos teléfonos no descargan
las fuentes (solo las páginas; en un teléfono el muro de TV no carga imágenes). Cada lectura registra lo que
descargó (`runs.wire`: cabeceras y cuerpos tal como llegaron) y la guía muestra lo medido en las últimas 24 horas
junto a la estimación.

**Detrás de un proxy inverso**, declare el proxy con `VIGIA_TRUST_PROXY`: así los límites de solicitudes son por
visitante (se toma la última entrada de `X-Forwarded-For`, la que añade su proxy) y no un solo cubo compartido por
todos. Solo se cree a los proxies declarados; cualquier otro cliente no puede hacerse pasar por otro.

**Reportes de usuarios** («¿tienes luz, agua, internet, gasolina?»): activos en los dos modos. Es la única escritura
anónima (sin la cookie de la terminal), con su propia guardia: JSON desde la propia página (el `Origin` debe nombrar
el `Host`), límites por conexión, prueba de trabajo, techo de ráfagas por municipio y un mínimo de personas distintas
antes de mostrar nada. En un espejo público solo se aceptan desde direcciones públicas: si su proxy no está declarado
en `VIGIA_TRUST_PROXY`, todos los visitantes llegarían con la dirección del proxy y se mezclarían en uno, así que los
reportes se rechazan (`503`, con el motivo) hasta declararlo. Con una CDN delante del proxy, declare los dos
(`VIGIA_TRUST_PROXY` admite rangos IPv4 e IPv6): `X-Forwarded-For` se lee desde la derecha saltando cada proxy
declarado. El proxy debe pasar la cabecera `Host` original (nginx: `proxy_set_header Host $host;`). En un Vigía personal con `--host 0.0.0.0`, los teléfonos de la casa reportan abriendo
Vigía por su dirección IP (`http://192.168.1.10:7722`), nunca por un nombre de dominio; sirviendo a la red, las
cifras se publican al cerrar cada bloque de 15 minutos, como en un espejo. Se guardan solo conteos por
municipio, servicio, respuesta y bloque de 15 minutos; nunca direcciones, navegador, cookies ni coordenadas.
`--no-crowd` o `VIGIA_CROWD=0` los apaga en esta instancia (lo publicado sigue en el archivo).

## Docker

```sh
docker compose up -d            # construye la imagen y arranca un espejo público en 127.0.0.1:7722
docker compose logs -f vigia    # registro en líneas JSON
```

La imagen (`Dockerfile`) contiene un único ejecutable compilado con el cliente web adentro, sobre `debian:stable-slim`,
y un ffmpeg mínimo para los cuadros de TV: FFmpeg 9.0.2 compilado desde la versión firmada con solo lo que usa el
decodificador (leer H.264 de una tubería, decodificar un cuadro, desentrelazar, escalar, escribir un PPM; sin
protocolos de red ni otros códecs), un programa de 2,8 MB. Su licencia (LGPL 2.1), la dirección de su código fuente y la línea de
`configure` están en `/usr/local/share/doc/ffmpeg/`. Medido el 2026-09-29: la imagen pasó de 72,9 a 74,0 MB comprimida (+1,1 MB) y de 255 a 259 MB en disco; el ffmpeg de la imagen decodificó el cuadro de prueba como el usuario `vigia` con el sistema de archivos de solo lectura, y la guía lo detecta. Corre como el usuario sin privilegios `vigia` (uid 10001), con los datos en el volumen `/data`, y
revisa su salud con `vigia healthcheck`. `compose.yaml` añade: sistema de archivos de solo lectura (solo `/data` y
un `/tmp` en memoria son escribibles), todas las capacidades del kernel retiradas, `no-new-privileges`, límite de
memoria (768 MB; en reposo usa unos 85 MB) y de procesos, y el puerto publicado solo en `127.0.0.1` para que lo sirva
su proxy con TLS.

Las claves van en un archivo `.env` junto a `compose.yaml` (nunca en el propio archivo ni en la imagen).

La imagen es para el modo público. Para uso personal, el ejecutable o `bun src/cli.ts` son más simples: dentro de un
contenedor, el navegador no llega desde la misma dirección de bucle local y la guía no podría guardar claves.

## systemd

`deploy/vigia.service` es una unidad de ejemplo para un espejo público sin Docker: usuario de sistema propio, datos
en `/var/lib/vigia` (`StateDirectory`), claves opcionales en `/etc/vigia/env` (modo 600), y el aislamiento de
systemd (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, sin capacidades). Las
instrucciones de instalación están en el propio archivo.

## Parada ordenada

Con SIGTERM o SIGINT (Ctrl+C, `docker stop`, `systemctl stop`), Vigía deja de programar lecturas, cierra los flujos
en vivo, termina las solicitudes en curso, espera a que las lecturas de fuentes en curso se registren (como máximo
8 s en total), pliega el registro WAL en la base de datos y cierra. Medido: 135 ms con una solicitud en curso, que
recibió su respuesta completa; `docker stop` en 386 ms.

## Respaldo y restauración

```sh
vigia backup                       # → <datos>/respaldos/vigia-AAAAMMDD-HHMMSS.sqlite (+ .json)
vigia backup /ruta/copia.sqlite
vigia restore /ruta/copia.sqlite   # con Vigía cerrado
```

- **Qué se copia:** todo el archivo: observaciones, registro de lecturas, la cadena sellada y sus hojas, el
  historial de conectividad, el registro de gastos de IA. **No se copian** las claves ni los ajustes (están en la
  carpeta de configuración, `vigia paths`), ni las imágenes guardadas (una caché con su propia retención).
- **Coherente con Vigía corriendo:** la copia es una sola transacción de lectura (`VACUUM INTO`), así que un Vigía
  escribiendo al mismo tiempo nunca produce una copia a medias, y no se le bloquea.
- **Verificada antes de confiar en ella:** `integrity_check` de SQLite, versión del esquema, y cada día sellado de la
  cadena recalculado. El manifiesto `.json` junto a la copia guarda su SHA-256, las filas por tabla y la cabeza de la
  cadena.
- **Restaurar** se niega mientras Vigía corre (un bloqueo exclusivo sobre `vigia.lock` en la carpeta de datos, que
  también impide abrir dos Vigía con los mismos datos; `vigia.pid` solo anota quién lo tiene), comprueba la huella
  contra el manifiesto, verifica la copia, guarda la base de datos actual aparte (`vigia.sqlite.antes-de-restaurar-…`,
  nunca la borra), pone la copia en su lugar y la verifica otra vez ahí: mismas filas por tabla y misma cabeza de la
  cadena. Si algo falla, devuelve la base anterior.
- **Los días sellados en este equipo mandan.** Que la copia sea coherente consigo misma no prueba que sea auténtica
  (se puede sellar de nuevo una historia alterada). Si la copia trae otra versión de un día que este equipo ya selló,
  la restauración se niega y lista esos días; solo `--force-replace-sealed` los reemplaza, a sabiendas.
- Necesita espacio libre para una copia más durante la verificación. Medido con un archivo de 47 MB (124 331
  observaciones): respaldo 0,36 s y restauración 1,6 s en el equipo; 2,8 s y 1,4 s dentro del contenedor.

Con Docker: `docker compose exec vigia vigia backup`, y para restaurar,
`docker compose stop vigia && docker compose run --rm vigia restore /data/data/respaldos/<archivo>.sqlite`.

## Métricas

`GET /metrics` en formato de texto de Prometheus: estado de cada fuente (el mismo de `/estado`), edad del último dato
y de la última lectura, fallos seguidos, tasa de éxito, lecturas e inserciones desde el arranque, histograma de
duración de las lecturas por fuente, solicitudes por familia de ruta y clase de estado, y histograma de latencia por
familia de ruta. Las etiquetas son acotadas: nunca rutas completas, consultas, direcciones ni navegadores.

- `loopback` (por defecto): solo desde este equipo, con una cabecera `Host` de bucle local. A través de un proxy
  inverso (que envía el `Host` público) responde `404`.
- `open`: para un Prometheus en una red privada. No lo exponga a internet.
- `off`: `404` siempre.

## Registros

`--log json` escribe un objeto JSON por línea (`ts`, `level`, `component`, `msg`), listo para journald, Docker o un
recolector. Vigía nunca registra a sus visitantes: ni líneas de solicitud ni direcciones.

## API pública de lectura

Documentación para personas en `/api` (en español), contrato OpenAPI 3.1 en `/api/v1/openapi.json`, y resumen en
`docs/API.md`.

## Informe diario para imprimir

`/informe`: el resumen construido por código (cifras con fuente y hora, lo más cubierto), los incidentes activos, el
estado de las fuentes, la licencia de cada fuente y la cabeza de la cadena del archivo, maquetado para A4. Imprimir →
Guardar como PDF en el navegador produce el PDF. Sin JavaScript; no cuesta nada a la carga de la aplicación.

## Accesibilidad

`bun run a11y [url]` recorre las páginas con axe-core (reglas WCAG 2.2 A y AA), en tema oscuro y claro, en escritorio
y teléfono, contra un Vigía en marcha, y deja el informe en `vigia-a11y.json` en la carpeta temporal (o en `A11Y_OUT`). Tarda más de un minuto, así que no
está en `bun run check`; corre a pedido y en CI cuando cambia la interfaz (`.github/workflows/a11y.yml`). Las
reglas automáticas encuentran una parte de los problemas; el recorrido con teclado y lector de pantalla sigue siendo
manual.

## Cabeceras de seguridad

Toda respuesta, de toda familia de rutas (aplicación, API, exportaciones, errores, `304`, documentación, informe,
métricas), lleva `Content-Security-Policy` (sin scripts de terceros, `frame-ancestors 'none'`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` y
`Permissions-Policy`. Una prueba lo comprueba por familia. HSTS lo pone su proxy con TLS.
