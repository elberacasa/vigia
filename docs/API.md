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

Las rutas internas de la aplicación (`/api/panels`, `/api/meta`, `/api/stream`, …) siguen existiendo para la página,
pero no son un contrato: pueden cambiar sin aviso. Use `/api/v1`.
