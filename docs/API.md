# API pública de lectura (v1)

Las cifras de Vigía para programas, hojas de cálculo e instituciones. La documentación completa está en la propia
instalación: **`/api`** (para personas, en español) y **`/api/v1/openapi.json`** (OpenAPI 3.1, generado de los
esquemas Zod del servidor, así que no puede desviarse del código).

```sh
curl http://localhost:7722/api/v1/panels
curl -o dinero.csv 'http://localhost:7722/api/v1/panels/money/figures?format=csv'
curl -o todo.csv 'http://localhost:7722/api/v1/figures?format=csv'
curl 'http://localhost:7722/api/v1/sources/bcv-history/series/usd-ves?format=csv'
```

## Rutas

| Ruta | Qué da |
|---|---|
| `/api/v1` | Índice: versión, modo, rutas |
| `/api/v1/sources`, `/api/v1/sources/{id}` | Cada fuente con licencia, atribución, claves, presupuesto de frescura y salud |
| `/api/v1/health` | Salud de todas las fuentes |
| `/api/v1/panels`, `/api/v1/panels/{id}` | La vista calculada de cada panel (lo que dibuja la página) |
| `/api/v1/panels/{id}/figures`, `/api/v1/figures` | Cada cifra en una fila con fuente, enlace, hora observada, hora recibida, atraso y licencia (JSON o CSV) |
| `/api/v1/sources/{id}/series`, `/…/series/{serie}` | Series temporales de las fuentes que permiten redistribuir sus filas (JSON o CSV) |
| `/api/v1/incidents`, `/api/v1/incidents/{id}` | Incidentes y su cronología |
| `/api/v1/history/connectivity` | Conectividad por estado, hora a hora, reconstruida con las reglas del panel (JSON o CSV) |
| `/api/v1/archive/digests` | La cadena sellada del archivo (solo resúmenes SHA-256) |
| `/api/v1/anomalies?entity=&class=&minScore=&explained=&limit=` | Lo inusual ahora: lecturas raras frente a su propia historia, calculadas por Vigía |
| `/api/v1/entities?q=&type=&limit=` | Buscar entidades por nombre, alias o código (o listar un tipo sin `q`) |
| `/api/v1/entities/{id}` | Una entidad: padres, hijos, cada señal viva sobre ella, incidentes, titulares, instalaciones y población |
| `/api/v1/entities/{id}/timeline?from=&to=&limit=&kinds=` | Los hechos del archivo vinculados a la entidad (por defecto 7 días, máximo 400) |
| `/api/v1/locate?lat=&lon=` | Parroquia, municipio y estado de un punto, e instalaciones a menos de 5 km |
| `/api/v1/stills?at=` | Máquina del tiempo: el cuadro de cada canal de TV, la miniatura de cada canal de YouTube y la imagen de cada cámara pública que la sala mostraba en `at` (tomadas a lo sumo 45 min antes; las cámaras, dentro de su intervalo), con su hora; `null` si no había |
| `/api/v1/cameras/{id}/stills?from=&to=&limit=` | Las imágenes fijas de una cámara del censo en una ventana (por defecto 6 h, máximo 3 días): hora, motivo si no hubo imagen, noche o día, parte encendida de su zona de luces |

## Reglas

- **Estable:** dentro de v1 solo se agregan campos y rutas. Un cambio incompatible sería `/api/v2`.
- **Horas:** milisegundos Unix (UTC) en JSON, ISO 8601 UTC en CSV. `observedAt` = cuándo la fuente dice que es
  cierto; `fetchedAt` = cuándo Vigía lo recibió.
- **Licencias:** cada fuente declara licencia y atribución. Las fuentes cuyos términos no permiten redistribuir sus
  filas (`licence.raw: false`: noticias, IODA, RIPEstat, YouTube) responden `403` en las rutas de series; de ellas
  solo se publican resultados derivados.
- **Cifras hechas por código:** ningún modelo produce una cifra. Una fila de cifras cuyo panel mezcla fuentes y no
  nombra la suya deja `feed` vacío y lista las fuentes del panel: nunca se adivina.
- **CSV:** RFC 4180, UTF-8 con BOM (abre bien en hojas de cálculo). Todo texto va entre comillas (los números no),
  así que una hoja que separa por `;` nunca parte una celda; el texto que una hoja ejecutaría como fórmula (`=`, `+`,
  `-`, `@`, también tras espacios iniciales) lleva un apóstrofo delante.
- **Caché:** `ETag` débil y `Last-Modified` en cada respuesta; `If-None-Match`/`If-Modified-Since` dan `304`.
- **CORS:** abierto (`*`, solo lectura, sin credenciales) en modo público o con `VIGIA_CORS=1`; cerrado en modo local.
- **Límites:** por cliente, ráfagas de 120 y 2 por segundo (exportaciones, series e historial cuentan 5); `429` con
  `Retry-After`.
- **Errores:** `{"error": "…"}` en español con el código HTTP que corresponde.

## Entidades

Cada lugar, instalación, red, medio e institución tiene un identificador estable y legible:

| Tipo | Ejemplo | De dónde sale |
|---|---|---|
| país, estado, municipio, parroquia | `ve`, `ve.zulia`, `ve.zulia.maracaibo`, `ve.distrito-capital.libertador.catedral` | Límites oficiales (INE vía OCHA COD-AB, CC BY-IGO 3.0) |
| infraestructura | `infra.planta-centro`, `infra.guri`, `infra.refineria-amuay`, `infra.aeropuerto-ccs`, `infra.red-765kv` | OpenStreetMap (ODbL), OurAirports (dominio público), IMF PortWatch |
| red | `net.cantv` (proveedor), `asn.8048` (sistema autónomo) | Tabla de proveedores de Vigía (titulares según IODA y RIPE) |
| medio | `outlet.el-pitazo` (todas sus fuentes: web, YouTube, Telegram) | Lista de medios de Vigía |
| institución | `inst.bcv`, `inst.cne`, `inst.mpp-salud` | Lista de Vigía; órganos con el nombre del índice de la Gaceta Oficial |
| cámara | `cam.charallave-oeste`, `cam.bonaire-kralendijk` | Censo de cámaras públicas de Vigía (solo cámaras que su operador publica), con su parroquia o municipio por punto en polígono |

- **Vínculos sin modelos:** punto en polígono, códigos de la fuente (estado, ASN, proveedor, órgano), el medio de
  cada titular, el etiquetador de palabras clave del panel de noticias (confianza ≥ 0,7, «ubicación por palabra
  clave»: en el título, o en el resumen si el título no nombra ningún lugar; una parroquia con nombre repetido en el
  país, como Catedral, solo si el texto nombra también su municipio o estado; una fecha nunca es un lugar),
  instituciones e instalaciones por su nombre **solo en el título** (`rule: "text-name"`, confianza 0,9) y distancias fijas (incendios a 1–2 km de una instalación o a 1 km de una línea; sismos de magnitud 4 o
  más a 30 km). Cada respuesta trae las reglas (`links.rules`) y cada hecho dice cómo se vinculó (`rule`).
- **Cada señal de `now`** trae fuente, enlace, hora observada, hora recibida, `stale` (la fuente superó su
  presupuesto de frescura o el dato es viejo), `basis`, y `computed: true` con `method` si la cifra la calcula
  Vigía. `scope` dice de qué entidad habla: IODA y las luces nocturnas miden por estado, así que un municipio
  muestra la cifra de su estado, marcada como tal.
- **Población:** censo 2011 (INE) y WorldPop 2026 lado a lado, nunca mezclados. `populationInArea` de un
  incidente con al menos dos familias de fuentes independientes (los reportes de usuarios se suman pero no cuentan;
  nunca de una señal sola ni de la prensa sola, aunque sean dos medios; `null` en los demás) es una estimación modelada (`basis: "estimate"`) calculada por
  Vigía: quienes viven en el estado de un corte, o a 10, 25 y 50 km de un sismo, en Venezuela. Nunca es el número
  de personas afectadas, sin servicio o que sintieron algo.
- **Conteos exactos:** las cifras de `now` que cuentan hechos vinculados (titulares, focos de calor, gacetas) se
  cuentan en la base, sin tope; cada serie cuenta una vez, por su revisión más reciente (un sismo revisado y
  reubicado sale del estado anterior). Un conteo o una ausencia solo se marca atrasado si su fuente no se está
  actualizando; los titulares, si la mayoría de los medios no se actualiza.
- **Instalaciones (`nearby`):** las que están dentro de un lugar (punto en polígono) o a menos de 20 km de una
  instalación, hasta 40, con `byKind` contando todas. `order: "distance"`: de la más cercana a la más lejana del
  punto de la entidad (`km`, un decimal); a igual distancia, por tipo (plantas, refinerías, petroquímicas,
  terminales, puertos, aeropuertos, represas, subestaciones, depósitos, campos, embalses, hospitales, líneas).
  `order: "kind"` solo si la entidad no tiene punto propio.
- **VE sin Filtro** aparece en el `now` de cada proveedor, no en su cronología: su lista se republica entera con
  una fecha nueva y no fecha cada bloqueo.
- **Licencias:** los hechos de fuentes que no permiten redistribuir sus datos (titulares, IODA, RIPEstat) llegan
  solo como resumen y enlace (`figures: null`).
- **Tipos para programas:** `src/ontology/view.ts` define las formas de estas respuestas (`EntityView`,
  `TimelineView`, `SearchView`, `LocateView`, `EntityRef`, `NowItem`…) sin dependencias, para importarlas con
  `import type`; los esquemas del OpenAPI describen lo mismo y una prueba de tipos los mantiene iguales.
- La cronología cuenta como petición pesada (5) para el límite por cliente. `kinds` admite quake, fire, flare,
  outage, hazard, headline, gazette, routing, incident y crowd. La búsqueda y el listado dicen `truncated` si hay más.
- **Reportes de usuarios** (`layer: "crowd"` en `now`, `kind: "crowd"` en la cronología): conteos publicados por
  municipio y por estado, con `basis: "report"`, `computed: true`, su método, `stale`, y la fuente `vigia-crowd`
  (licencia CC0, «Reportes anónimos de usuarios de esta instancia de Vigía»). Nunca son una medición. El país no
  tiene reportes de usuarios en su `now` ni en su cronología.

## Reportes de usuarios

«¿Tienes luz / agua / internet / gasolina (o gas) ahora?» → sí / no / intermitente, por municipio. Lectura: el panel
`crowd` (`/api/v1/panels/crowd`, y en `now` y la cronología de cada municipio y estado). Escritura, solo desde la
propia página de Vigía (no es parte de v1; guardia en SECURITY.md):

| Ruta | Qué hace |
|---|---|
| `GET /api/crowd` | `enabled`, `mode`, servicios con su pregunta, respuestas, ventana (2 h), bloque (15 min), mínimo de personas, límites, la prueba de trabajo, la licencia, `rules` (el texto de las reglas, generado de las constantes) y `stored` (qué se guarda, exactamente) |
| `GET /api/crowd/challenge` | `{challenge, difficulty, expiresAt, algorithm: "sha256-leading-zero-bits"}`: hallar `nonce` (contador en base 36, 1–16 caracteres) tal que SHA-256(`challenge + ":" + nonce`) empiece con `difficulty` bits en cero. Vale 10 min y una sola vez |
| `POST /api/crowd/reports` | `{municipality: "ve.zulia.maracaibo" (o su P-code, "VE2313"), answers: {luz: "no", internet: "intermitente"}, challenge, nonce, token?}`; `token`: identificador aleatorio del teléfono (16 bytes al azar en base64url, 22 caracteres), opcional, para que varios teléfonos detrás de una misma dirección cuenten por separado (hasta 4 por municipio y servicio); nunca se guarda tal cual → `{ok, municipality: {id, name, state}, results: [{service, answer, status: "received"}], publishedFrom}`; `status` es siempre `received` (si se contó, se retuvo o reemplazó una respuesta anterior de la misma dirección no se dice en el momento); `publishedFrom`: desde cuándo cuenta en lo publicado |

Errores: `400 invalid` (cuerpo, municipio, servicio, respuesta o `token` mal formado), `403 origin`/`remote`/`pow`, `404 off` (apagado con
`VIGIA_CROWD=0`), `413 size`, `415 json`, `429 rate`/`municipalities` con `Retry-After`, `503 busy` (demasiados
reportes en el estado en este minuto)/`proxy`. Solo se
aceptan las claves `municipality`, `answers`, `challenge`, `nonce` y `token`: un cuerpo con coordenadas u otro campo se
rechaza. En el panel y en `now`, cada cifra trae `reports` y `connections` (direcciones distintas); un municipio se
muestra con al menos 3 reportes de al menos 2 conexiones en un espejo público.

  outage, hazard, headline, gazette, routing, incident, sanction, licence e intervention (sin `kinds` vienen todos
  estos), y gdelt, lightning, broadcast, office y market, que solo vienen si se piden: son cientos al día (artículos
  de GDELT, ventanas de rayos) o directorios (canales y radios, cargos, mercados). La búsqueda y el listado dicen
  `truncated` si hay más.
- **Fuentes nuevas (reglas v4):** artículos de GDELT al lugar de su geocodificación automática (confianza 0,5, nunca
  al país) y al medio dueño del sitio; ventanas de rayos de GOES-19 GLM a los estados con destellos, al municipio del
  centro de cada celda de 0,25° (confianza 0,5) y a las instalaciones dentro de una celda con destellos; canales de TV
  y radios a los estados que atienden y a su medio; en OFAC, las designaciones y exclusiones de órganos del Estado
  venezolano (por el número de registro de OFAC, lista revisada a mano: BCV, PDVSA, Conviasa, bancos públicos,
  Minerven, INEA, DGCIM) y las instituciones que nombra el cargo de un funcionario público identificado; licencias
  generales, avisos de OFAC y documentos del Federal Register a las instituciones que nombra su título; cargos de
  Wikidata a su institución (o al estado, si es una gobernación); intervenciones cambiarias al BCV; mercados de
  predicción al país. Las listas revisadas a mano están en `src/ontology/state-names.ts`.
- El `now` suma rayos (24 h y última hora, por estado, municipio o instalación), artículos de GDELT (24 h, por
  estado), canales y radios del directorio, cargos según Wikidata (instituciones y gobernaciones, solo funcionarios
  públicos), si un órgano del Estado está en la lista SDN de OFAC, y los mercados de predicción sobre el país.

## Lo inusual ahora (anomalías)

`/api/v1/anomalies` compara el dato más reciente de cada serie numérica (fuente × entidad × métrica) con su propia
historia, con reglas fijas y sin modelos, y devuelve las lecturas raras ordenadas por puntuación. Cada una trae la
entidad, la métrica y su unidad, el valor y lo que esperaba la línea base, la ventana de la línea base (en palabras,
cuántos puntos y sus fechas), la puntuación (z robusta), la regla en palabras con sus números, la fuente y la edad.
`computed: true`, `basis: "derived"`: es una cifra calculada por Vigía, nunca una medición ni un pronóstico.

| Clase | Series | Línea base | Inusual |
|---|---|---|---|
| `connectivity` | IODA por estado, proveedor y país | la lectura del panel de conectividad (misma franja de 10 min, 7 días) | solo «caída fuerte», el nivel de los incidentes |
| `night` | luces nocturnas por estado | hasta 14 noches despejadas | noche comparable −30 % o menos (regla de los incidentes) |
| `change` | tasas oficiales del BCV, reservas, M2, INPC, Yadio, Binance P2P, Brent, WTI | mediana y MAD de los 60 cambios diarios (52 semanales, 36 mensuales) | \|z\| ≥ 4 y un cambio mínimo por serie; las reservas se juzgan aparte en los cierres de mes |
| `level` | usuarios de Tor, visitas a Wikipedia | 28 días, en escala logarítmica | \|z\| ≥ 4 y una razón mínima; Tor directo además fuera del rango de Tor Metrics |
| `count` | focos de calor, eventos de GDELT, titulares que nombran un lugar o institución | 28 días con datos | solo hacia arriba: z ≥ 4, ≥ 3 × la mediana, Poisson ≤ 1e-4, mínimo por serie |
| `hourly` | rayos (GLM) por estado | la misma hora de 14 días | como `count`, con ≥ 5 × la mediana y ≥ 300 destellos |

- **Sin historia suficiente o con el dato viejo no hay anomalía**; `counts` dice cuántas series se miraron, cuántas se
  juzgaron y por qué no las demás (`thin`, `stale`, `weak`), también por clase.
- **Licencias:** de las fuentes que no permiten redistribuir sus datos (IODA) solo se publican el cambio (%) y la
  puntuación; `value` y `baseline` van en `null`.
- **Incidentes:** si un incidente abierto (o terminado hace menos de 3 h) en el mismo estado ya la explica (un corte
  explica conectividad, luces, titulares y GDELT; un sismo, conectividad, titulares y GDELT), `explainedBy` apunta a él.
- Filtros: `entity` (la entidad o lo que está dentro de ella), `class`, `minScore` (|puntuación| mínima),
  `explained=0|1`, `limit` (1–100). Cada página de entidad trae su bloque `anomalies` (las suyas y las de su estado).
- **Caídas regionales:** dos o más estados cuyas caídas fuertes empezaron a menos de 30 min una de otra son un solo
  hecho (`metric.id: "connectivity.region"`, entidad el país) con `members`: cada estado con su propia cifra, nunca
  una combinada. Las lecturas por estado vienen en `grouped` (con `groupId`) y en la página de cada estado.
- **Movimientos revertidos:** si las reservas del BCV vuelven cerca del nivel anterior en los 5 datos publicados
  siguientes, el salto se muestra una vez con `reverted` («revertido por el BCV a los N días hábiles»), al final de la
  lista. Es un hecho de la serie, no una explicación. Cada lectura trae `title`, una línea lista para mostrar.
- Las reglas en palabras vienen en `rules` y se generan de las mismas constantes que usa el código
  (`src/intel/anomaly.ts`).

Las rutas internas de la aplicación (`/api/panels`, `/api/meta`, `/api/stream`, …) siguen existiendo para la página,
pero no son un contrato: pueden cambiar sin aviso. Use `/api/v1`.
