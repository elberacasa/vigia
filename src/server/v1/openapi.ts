import { z } from "zod";
import * as S from "./schemas.ts";

/**
 * The OpenAPI 3.1 document of the read API, generated from the Zod schemas in schemas.ts (JSON Schema 2020-12 is
 * OpenAPI 3.1's own dialect, so nothing is translated by hand). The route table below is also what the /api docs
 * page and the /api/v1 index list, so the three never drift apart.
 */

const COMPONENTS = {
	Error: S.ErrorResponse,
	Json: S.JsonValue,
	Licence: S.Licence,
	Source: S.Source,
	FeedState: S.FeedState,
	Health: S.Health,
	Observation: S.Observation,
	Figure: S.Figure,
	PanelSummary: S.PanelSummary,
	IndexResponse: S.IndexResponse,
	SourcesResponse: S.SourcesResponse,
	SourceResponse: S.SourceResponse,
	HealthResponse: S.HealthResponse,
	PanelsResponse: S.PanelsResponse,
	PanelResponse: S.PanelResponse,
	FiguresResponse: S.FiguresResponse,
	SeriesListResponse: S.SeriesListResponse,
	SeriesResponse: S.SeriesResponse,
	IncidentsResponse: S.IncidentsResponse,
	IncidentResponse: S.IncidentResponse,
	AnomalyItem: S.AnomalyItem,
	AnomaliesResponse: S.AnomaliesResponse,
	ConnectivityHistoryResponse: S.ConnectivityHistoryResponse,
	DigestsResponse: S.DigestsResponse,
	EntityRef: S.EntityRef,
	EntityDetail: S.EntityDetail,
	NowItem: S.NowItem,
	EntityResponse: S.EntityResponse,
	TimelineResponse: S.TimelineResponse,
	EntitySearchResponse: S.EntitySearchResponse,
	LocateResponse: S.LocateResponse,
	StillImage: S.StillImage,
	StillsResponse: S.StillsResponse,
	CameraStillsResponse: S.CameraStillsResponse,
} as const;

type ComponentName = keyof typeof COMPONENTS;

interface Param {
	readonly name: string;
	readonly in: "path" | "query";
	readonly description: string;
	readonly schema: Record<string, unknown>;
	readonly required?: boolean;
}

export interface Operation {
	readonly path: string;
	readonly id: string;
	readonly tag: string;
	readonly summary: string;
	readonly description: string;
	readonly response: ComponentName;
	readonly params?: readonly Param[];
	/** Also answers text/csv with ?format=csv. */
	readonly csv?: string;
	/** Example path for the docs page. */
	readonly example: string;
}

const format: Param = {
	name: "format",
	in: "query",
	description: "json (por defecto) o csv. También vale la cabecera Accept: text/csv.",
	schema: { type: "string", enum: ["json", "csv"] },
};
const sourceId: Param = {
	name: "id",
	in: "path",
	required: true,
	description: "Identificador de la fuente (ver /api/v1/sources).",
	schema: { type: "string", pattern: "^[\\w.-]{1,80}$" },
};
const panelId: Param = {
	name: "id",
	in: "path",
	required: true,
	description: "Identificador del panel (ver /api/v1/panels).",
	schema: { type: "string", pattern: "^[\\w-]{1,80}$" },
};

const entityId: Param = {
	name: "id",
	in: "path",
	required: true,
	description:
		"Identificador de la entidad: ve, ve.zulia, ve.zulia.maracaibo, infra.planta-centro, asn.8048, outlet.el-pitazo, inst.bcv…",
	schema: { type: "string", pattern: "^[a-z0-9][a-z0-9.-]{0,150}$" },
};

export const OPERATIONS: readonly Operation[] = [
	{
		path: "/api/v1",
		id: "index",
		tag: "General",
		summary: "Índice de la API",
		description: "Versión, modo de despliegue y la lista de rutas.",
		response: "IndexResponse",
		example: "/api/v1",
	},
	{
		path: "/api/v1/sources",
		id: "listSources",
		tag: "Fuentes",
		summary: "Todas las fuentes, con licencia y presupuesto de frescura",
		description:
			"Cada adaptador de Vigía: quién publica los datos, su licencia y atribución, si necesita clave, cada cuánto se consulta y qué paneles alimenta.",
		response: "SourcesResponse",
		example: "/api/v1/sources",
	},
	{
		path: "/api/v1/sources/{id}",
		id: "getSource",
		tag: "Fuentes",
		summary: "Una fuente y su salud",
		description: "La ficha de una fuente y su estado actual (el mismo de la página de estado).",
		response: "SourceResponse",
		params: [sourceId],
		example: "/api/v1/sources/usgs-quakes",
	},
	{
		path: "/api/v1/sources/{id}/series",
		id: "listSeries",
		tag: "Series",
		summary: "La observación más reciente de cada serie de una fuente",
		description:
			"Solo para fuentes cuyos términos permiten redistribuir sus filas (licence.raw distinto de false); las demás responden 403 y solo se publican sus resultados derivados (paneles, cifras).",
		response: "SeriesListResponse",
		params: [
			sourceId,
			{
				name: "since",
				in: "query",
				description: "Solo series observadas desde este instante (Unix ms).",
				schema: { type: "integer", minimum: 0 },
			},
			{
				name: "limit",
				in: "query",
				description: "Máximo de series (1–1000, por defecto 200).",
				schema: { type: "integer", minimum: 1, maximum: 1000 },
			},
			format,
		],
		csv: "source,series,observed_at,fetched_at,value,source_url,licence,licence_url,attribution,confidence,basis,lat,lon,state,place",
		example: "/api/v1/sources/bcv-history/series",
	},
	{
		path: "/api/v1/sources/{id}/series/{series}",
		id: "getSeries",
		tag: "Series",
		summary: "Serie temporal: cada revisión guardada en una ventana",
		description:
			"Historial de una serie (por defecto los últimos 7 días; como máximo 400 días y 5000 filas). Mismas reglas de licencia que la lista de series.",
		response: "SeriesResponse",
		params: [
			sourceId,
			{
				name: "series",
				in: "path",
				required: true,
				description: "Identificador de la serie dentro de la fuente.",
				schema: { type: "string" },
			},
			{ name: "from", in: "query", description: "Inicio (Unix ms).", schema: { type: "integer" } },
			{
				name: "to",
				in: "query",
				description: "Fin (Unix ms; por defecto ahora).",
				schema: { type: "integer" },
			},
			format,
		],
		csv: "source,series,observed_at,fetched_at,value,source_url,licence,licence_url,attribution,confidence,basis,lat,lon,state,place",
		example: "/api/v1/sources/bcv-history/series/usd-ves?format=csv",
	},
	{
		path: "/api/v1/health",
		id: "health",
		tag: "Salud",
		summary: "Salud de todas las fuentes",
		description:
			"Estado, edad del último dato y de la última lectura, fallos seguidos y próxima lectura de cada fuente.",
		response: "HealthResponse",
		example: "/api/v1/health",
	},
	{
		path: "/api/v1/panels",
		id: "listPanels",
		tag: "Paneles",
		summary: "Los paneles y sus fuentes",
		description:
			"Cada panel de la página, las fuentes de las que se calcula y los enlaces a su vista y sus cifras.",
		response: "PanelsResponse",
		example: "/api/v1/panels",
	},
	{
		path: "/api/v1/panels/{id}",
		id: "getPanel",
		tag: "Paneles",
		summary: "La vista calculada de un panel",
		description:
			"Lo mismo que dibuja la página: cada cifra calculada por código, con su fuente y sus horas. La forma interna es propia de cada panel.",
		response: "PanelResponse",
		params: [panelId],
		example: "/api/v1/panels/money",
	},
	{
		path: "/api/v1/panels/{id}/figures",
		id: "getPanelFigures",
		tag: "Paneles",
		summary: "Las cifras de un panel en filas (JSON o CSV)",
		description:
			"Cada número de la vista del panel en una fila, con su fuente, enlace, hora observada, hora recibida, si está atrasado y su licencia.",
		response: "FiguresResponse",
		params: [panelId, format],
		csv: "panel,path,label,value,feed,source_url,observed_at,fetched_at,stale,licence,licence_url,attribution,panel_sources",
		example: "/api/v1/panels/money/figures?format=csv",
	},
	{
		path: "/api/v1/figures",
		id: "getAllFigures",
		tag: "Paneles",
		summary: "Todas las cifras de todos los paneles (JSON o CSV)",
		description: "Las cifras de cada panel juntas, en una sola descarga.",
		response: "FiguresResponse",
		params: [format],
		csv: "panel,path,label,value,feed,source_url,observed_at,fetched_at,stale,licence,licence_url,attribution,panel_sources",
		example: "/api/v1/figures?format=csv",
	},
	{
		path: "/api/v1/incidents",
		id: "listIncidents",
		tag: "Incidentes",
		summary: "Incidentes activos y recientes",
		description:
			"Incidentes que el código abre cuando señales independientes coinciden, con su evidencia enlazada y las reglas que los abren.",
		response: "IncidentsResponse",
		example: "/api/v1/incidents",
	},
	{
		path: "/api/v1/incidents/{id}",
		id: "getIncident",
		tag: "Incidentes",
		summary: "Un incidente y su cronología",
		description: "El incidente y una línea por cada revisión archivada.",
		response: "IncidentResponse",
		params: [
			{
				name: "id",
				in: "path",
				required: true,
				description: "Identificador del incidente.",
				schema: { type: "string" },
			},
		],
		example: "/api/v1/incidents",
	},
	{
		path: "/api/v1/anomalies",
		id: "listAnomalies",
		tag: "Incidentes",
		summary: "Lo inusual ahora: lecturas raras frente a su propia historia",
		description:
			"Cada serie numérica que guarda Vigía (fuente × entidad × métrica) comparada con una línea base según su ritmo: la misma franja horaria para la conectividad, mediana y MAD móviles para las series diarias, reglas de conteo con cola de Poisson para los conteos de hechos. Sin historia suficiente o con datos viejos no hay anomalía. Cada lectura trae valor, línea base y su ventana, puntuación, la regla en palabras, fuente y edad; las fuentes que no permiten redistribuir sus datos (IODA) dan solo el cambio y la puntuación. Si un incidente abierto ya la explica, apunta a él. Calculado por Vigía, sin modelos.",
		response: "AnomaliesResponse",
		params: [
			{
				name: "entity",
				in: "query",
				description: "Solo lecturas de esta entidad o de lo que está dentro de ella (ve.zulia, inst.bcv).",
				schema: { type: "string" },
			},
			{
				name: "class",
				in: "query",
				description: "Solo esta clase: connectivity, night, change, level, count, hourly.",
				schema: { type: "string" },
			},
			{
				name: "minScore",
				in: "query",
				description: "Solo lecturas con |puntuación| de al menos este valor.",
				schema: { type: "number" },
			},
			{
				name: "explained",
				in: "query",
				description: "0: solo las que ningún incidente explica; 1: solo las explicadas.",
				schema: { type: "integer", enum: [0, 1] },
			},
			{
				name: "limit",
				in: "query",
				description: "Máximo de lecturas (1–100, por defecto 50).",
				schema: { type: "integer", minimum: 1, maximum: 100 },
			},
		],
		example: "/api/v1/anomalies",
	},
	{
		path: "/api/v1/history/connectivity",
		id: "connectivityHistory",
		tag: "Historial",
		summary: "Conectividad por estado, paso a paso (derivada)",
		description:
			"El nivel de conectividad de cada estado en cada paso, reconstruido con las reglas del panel sobre los datos guardados. Ventana: 1h hasta 7 días, 6h y 1d hasta 31 días.",
		response: "ConnectivityHistoryResponse",
		params: [
			{ name: "from", in: "query", description: "Inicio (Unix ms).", schema: { type: "integer" } },
			{ name: "to", in: "query", description: "Fin (Unix ms).", schema: { type: "integer" } },
			{
				name: "step",
				in: "query",
				description: "Paso.",
				schema: { type: "string", enum: ["1h", "6h", "1d"] },
			},
			format,
		],
		csv: "time,state,level,step,feed,source_url,licence,attribution,computed_at",
		example: "/api/v1/history/connectivity?step=1d&format=csv",
	},
	{
		path: "/api/v1/archive/digests",
		id: "archiveDigests",
		tag: "Archivo",
		summary: "La cadena sellada del archivo (solo resúmenes)",
		description:
			"El resumen SHA-256 de cada día UTC sellado, encadenado al anterior. Compruébelo con `vigia verify`.",
		response: "DigestsResponse",
		params: [
			{ name: "from", in: "query", description: "Día inicial AAAA-MM-DD.", schema: { type: "string" } },
			{ name: "to", in: "query", description: "Día final AAAA-MM-DD.", schema: { type: "string" } },
		],
		example: "/api/v1/archive/digests",
	},
	{
		path: "/api/v1/entities",
		id: "searchEntities",
		tag: "Entidades",
		summary: "Buscar entidades (lugares, instalaciones, redes, medios, instituciones)",
		description:
			"Busca por nombre, alias o código (código P, ISO, ASN, IATA). Con type y sin q, lista las entidades de ese tipo (hasta 500).",
		response: "EntitySearchResponse",
		params: [
			{
				name: "q",
				in: "query",
				description: "Texto a buscar (hasta 100 caracteres).",
				schema: { type: "string" },
			},
			{
				name: "type",
				in: "query",
				description: "Tipo de entidad.",
				schema: {
					type: "string",
					enum: [
						"country",
						"state",
						"municipality",
						"parish",
						"infrastructure",
						"network",
						"outlet",
						"institution",
					],
				},
			},
			{
				name: "limit",
				in: "query",
				description: "Máximo de resultados (1–50 al buscar, 1–500 al listar; por defecto 20).",
				schema: { type: "integer", minimum: 1, maximum: 500 },
			},
		],
		example: "/api/v1/entities?q=maracaibo",
	},
	{
		path: "/api/v1/entities/{id}",
		id: "getEntity",
		tag: "Entidades",
		summary: "Una entidad: lo que dicen hoy todas las señales sobre ella",
		description:
			"La entidad, sus padres e hijos, cada señal viva sobre ella (con fuente, horas y marca de atraso), sus incidentes, titulares recientes, instalaciones dentro o cerca, y su población (censo 2011 y WorldPop 2026, lado a lado). Las cifras que calcula Vigía dicen calculado y cómo.",
		response: "EntityResponse",
		params: [entityId],
		example: "/api/v1/entities/ve.zulia",
	},
	{
		path: "/api/v1/entities/{id}/timeline",
		id: "getEntityTimeline",
		tag: "Entidades",
		summary: "Cronología de una entidad desde el archivo",
		description:
			"Los hechos vinculados a la entidad en una ventana (por defecto 7 días, máximo 400): sismos, incendios, quemas, cortes, titulares, gacetas, rutas, incidentes, sanciones de OFAC, licencias y documentos del Federal Register, intervenciones del BCV. Los artículos de GDELT, los rayos, los canales y radios, los cargos y los mercados de predicción también están vinculados, pero solo vienen si se piden con kinds. Cada hecho dice cómo se vinculó. Las fuentes que no permiten redistribuir sus datos dan solo un resumen y el enlace.",
		response: "TimelineResponse",
		params: [
			entityId,
			{ name: "from", in: "query", description: "Inicio (Unix ms).", schema: { type: "integer" } },
			{
				name: "to",
				in: "query",
				description: "Fin (Unix ms; por defecto ahora).",
				schema: { type: "integer" },
			},
			{
				name: "limit",
				in: "query",
				description: "Máximo de hechos (1–500, por defecto 100).",
				schema: { type: "integer", minimum: 1, maximum: 500 },
			},
			{
				name: "kinds",
				in: "query",
				description:
					"Solo estos tipos, separados por comas: quake, fire, flare, outage, hazard, headline, gazette, routing, incident, crowd (reportes de usuarios), sanction, licence, intervention (por omisión, todos estos) y gdelt, lightning, broadcast, office, market (solo si se piden).",
				schema: { type: "string" },
			},
		],
		example: "/api/v1/entities/ve.zulia/timeline",
	},
	{
		path: "/api/v1/locate",
		id: "locate",
		tag: "Entidades",
		summary: "Qué hay en un punto: parroquia, municipio, estado e instalaciones cercanas",
		description: "Punto en polígono con los límites oficiales (COD-AB) e instalaciones a menos de 5 km.",
		response: "LocateResponse",
		params: [
			{ name: "lat", in: "query", required: true, description: "Latitud.", schema: { type: "number" } },
			{ name: "lon", in: "query", required: true, description: "Longitud.", schema: { type: "number" } },
		],
		example: "/api/v1/locate?lat=10.65&lon=-71.64",
	},
	{
		path: "/api/v1/stills",
		id: "stills",
		tag: "Imágenes",
		summary: "Las imágenes de la sala en un momento: cuadros de TV y cámaras públicas",
		description:
			"Máquina del tiempo: cada canal y cada cámara con la imagen que la sala mostraba en `at` (tomada a lo sumo 45 min antes, o dentro del intervalo de la cámara), con su hora; sin imagen en ese lapso, null. Las imágenes viven en este servidor (TV un día, cámaras tres días).",
		response: "StillsResponse",
		params: [
			{
				name: "at",
				in: "query",
				description: "Momento (Unix ms); por defecto ahora. Hasta 400 días atrás.",
				schema: { type: "integer" },
			},
		],
		example: "/api/v1/stills",
	},
	{
		path: "/api/v1/cameras/{id}/stills",
		id: "cameraStills",
		tag: "Imágenes",
		summary: "Las imágenes fijas de una cámara pública en una ventana, con su brillo",
		description:
			"Tira de imágenes de una cámara del censo (ver /api/v1/panels/cameras), la más antigua primero: hora, motivo si no hubo imagen, si era de noche y la parte encendida de su zona de luces. Ventana de hasta 3 días.",
		response: "CameraStillsResponse",
		params: [
			{
				name: "id",
				in: "path",
				required: true,
				description: "Identificador de la cámara (charallave-oeste, bonaire-kralendijk…).",
				schema: { type: "string", pattern: "^[a-z0-9-]{1,60}$" },
			},
			{
				name: "from",
				in: "query",
				description: "Desde (Unix ms); por defecto 6 h antes de to.",
				schema: { type: "integer" },
			},
			{
				name: "to",
				in: "query",
				description: "Hasta (Unix ms); por defecto ahora.",
				schema: { type: "integer" },
			},
			{
				name: "limit",
				in: "query",
				description: "Máximo de imágenes (1–500, por defecto 200).",
				schema: { type: "integer" },
			},
		],
		example: "/api/v1/cameras/charallave-oeste/stills",
	},
];

const ERRORS: Record<string, string> = {
	"400": "Parámetros no válidos.",
	"403": "Los términos de la fuente no permiten redistribuir sus filas.",
	"404": "No existe.",
	"429": "Demasiadas solicitudes; la cabecera Retry-After dice cuánto esperar.",
};

function ref(name: string) {
	return { $ref: `#/components/schemas/${name}` };
}

/** Removes what OpenAPI does not need from each component, and keeps v1 open to added fields. */
function tidy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(tidy);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "$schema" || k === "$id") continue;
			// Clients must accept fields added later in v1 (the stability promise), so no closed objects.
			if (k === "additionalProperties" && v === false) continue;
			out[k] = tidy(v);
		}
		return out;
	}
	return value;
}

let cached: Record<string, unknown> | null = null;

export function openApiDocument(version: string): Record<string, unknown> {
	if (cached && (cached.info as { version: string }).version === version) return cached;
	const registry = z.registry<{ id: string }>();
	for (const [id, schema] of Object.entries(COMPONENTS)) registry.add(schema, { id });
	const generated = z.toJSONSchema(registry, {
		target: "draft-2020-12",
		uri: (id) => `#/components/schemas/${id}`,
		unrepresentable: "any",
	}) as { schemas: Record<string, unknown> };
	const schemas = tidy(generated.schemas) as Record<string, unknown>;

	const paths: Record<string, unknown> = {};
	for (const op of OPERATIONS) {
		const content: Record<string, unknown> = { "application/json": { schema: ref(op.response) } };
		if (op.csv)
			content["text/csv"] = {
				schema: { type: "string" },
				example: `${op.csv}\r\n`,
			};
		const errors = Object.fromEntries(
			Object.entries(ERRORS).map(([code, description]) => [
				code,
				{ description, content: { "application/json": { schema: ref("Error") } } },
			]),
		);
		paths[op.path] = {
			get: {
				operationId: op.id,
				tags: [op.tag],
				summary: op.summary,
				description: op.description,
				parameters: op.params ?? [],
				responses: {
					"200": {
						description: "Correcto.",
						headers: {
							ETag: { schema: { type: "string" }, description: "Etiqueta débil del contenido." },
							"Last-Modified": {
								schema: { type: "string" },
								description: "Cuándo cambió este contenido por última vez.",
							},
						},
						content,
					},
					"304": { description: "Sin cambios desde If-None-Match o If-Modified-Since." },
					...errors,
				},
			},
		};
	}

	cached = {
		openapi: "3.1.0",
		jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
		info: {
			title: "Vigía: API pública de lectura",
			version,
			summary:
				"Cifras de la sala de situación de Venezuela, cada una con su fuente, sus horas y su licencia.",
			description:
				"API de solo lectura, versionada (v1: los campos solo se agregan, nunca se cambian ni se quitan). Horas en milisegundos Unix (UTC) en JSON e ISO 8601 UTC en CSV. Respeta los términos de cada fuente: las filas de fuentes que no permiten redistribución no se publican, solo resultados derivados. Documentación: /api",
			license: {
				name: "PolyForm Noncommercial 1.0.0",
				url: "https://polyformproject.org/licenses/noncommercial/1.0.0/",
			},
		},
		servers: [{ url: "/" }],
		tags: [...new Set(OPERATIONS.map((o) => o.tag))].map((name) => ({ name })),
		paths,
		components: { schemas },
	};
	return cached;
}
