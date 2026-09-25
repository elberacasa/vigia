import { z } from "zod";

/**
 * The public read API's response shapes (version 1). They are the single source of truth: the OpenAPI document is
 * generated from them (openapi.ts), and the tests parse real responses with them and require nothing to be lost, so
 * a field the schema does not describe fails the build.
 *
 * Stability promise within v1: fields and endpoints are only added, never renamed, removed or retyped. Times are
 * Unix milliseconds (UTC) in JSON and ISO 8601 UTC in CSV.
 */

export const API_VERSION = "1";

const ms = (description: string) =>
	z
		.number()
		.int()
		.meta({ description: `${description} (Unix ms, UTC)` });
const msOrNull = (description: string) =>
	z
		.number()
		.int()
		.nullable()
		.meta({ description: `${description} (Unix ms, UTC; null si no se sabe)` });

export const JsonValue = z.json().meta({ description: "Cualquier valor JSON." });

export const Bilingual = z
	.object({ es: z.string(), en: z.string() })
	.meta({ description: "Texto en español e inglés." });

export const Licence = z
	.object({
		id: z.string().meta({ description: "Identificador de la licencia." }),
		name: z.string(),
		url: z.string().meta({ description: "Texto de la licencia o términos de la fuente." }),
		attribution: z.string().meta({ description: "Atribución que debe acompañar a los datos." }),
		commercial: z.union([z.boolean(), z.literal("unclear")]),
		raw: z.boolean().meta({
			description:
				"false: los términos no permiten redistribuir las filas de la fuente; la API solo publica resultados derivados.",
		}),
	})
	.meta({ description: "Licencia y términos de una fuente." });

export const Source = z
	.object({
		id: z.string(),
		layer: z.enum(["money", "earth", "internet", "news", "social", "oil", "society"]),
		name: Bilingual,
		provider: z.string(),
		homepage: z.string(),
		licence: Licence,
		keys: z.array(z.string()).meta({ description: "Claves que necesita (vacío: abierta)." }),
		intervalMs: z.number().int().meta({ description: "Cada cuánto se consulta (ms)." }),
		freshness: z.object({
			fetchMs: z
				.number()
				.int()
				.meta({ description: "Una lectura exitosa más vieja que esto la marca atrasada." }),
			dataMs: z
				.number()
				.int()
				.nullable()
				.meta({ description: "Un dato más viejo que esto la marca atrasada (null: fuente de eventos)." }),
		}),
		optIn: Bilingual.nullable().meta({ description: "Apagada por defecto, y por qué." }),
		panels: z.array(z.string()).meta({ description: "Paneles que la usan." }),
		rawAvailable: z.boolean().meta({ description: "Si /sources/{id}/series publica sus filas." }),
	})
	.meta({ description: "Una fuente (adaptador) de Vigía." });

export const FeedState = z.enum(["ok", "stale", "degraded", "failing", "locked", "off", "pending"]).meta({
	description:
		"ok: al día. stale: dato más viejo que su presupuesto. degraded: fallos recientes, dato aún al día. failing: falla y sin dato al día. locked: falta una clave. off: apagada. pending: sin intentos todavía.",
});

export const Health = z
	.object({
		id: z.string(),
		state: FeedState,
		lastSuccessAt: msOrNull("Última lectura exitosa"),
		lastAttemptAt: msOrNull("Último intento"),
		newestObservedAt: msOrNull("Hora del dato más reciente según la fuente"),
		fetchAgeMs: z.number().int().nullable(),
		dataAgeMs: z.number().int().nullable(),
		lastError: z.string().nullable(),
		consecutiveFailures: z.number().int(),
		nextRunAt: msOrNull("Próxima lectura"),
		successRate: z.number().nullable().meta({ description: "Fracción de lecturas exitosas (últimas 50)." }),
		medianLatencyMs: z.number().nullable(),
	})
	.meta({ description: "Salud de una fuente, la misma de la página de estado." });

export const Observation = z
	.object({
		source: z.string(),
		series: z.string(),
		observedAt: ms("Cuándo la fuente dice que es cierto"),
		fetchedAt: ms("Cuándo Vigía lo recibió"),
		value: JsonValue,
		sourceUrl: z.string(),
		licence: z.string(),
		confidence: z.number().min(0).max(1),
		basis: z.enum(["measurement", "official", "quote", "report", "derived"]),
		location: z
			.object({
				lat: z.number(),
				lon: z.number(),
				state: z.string().optional(),
				place: z.string().optional(),
			})
			.optional(),
	})
	.meta({ description: "Una observación guardada, tal como la normalizó el adaptador." });

export const Figure = z
	.object({
		panel: z.string(),
		path: z.string().meta({ description: "Dónde está la cifra en la vista del panel." }),
		label: z.string().nullable(),
		value: z.union([z.number(), z.string()]),
		feed: z.string().nullable().meta({ description: "Fuente de la cifra, cuando la vista la nombra." }),
		sourceUrl: z.string().nullable(),
		observedAt: msOrNull("Cuándo la fuente dice que es cierto"),
		fetchedAt: msOrNull("Cuándo Vigía lo recibió"),
		stale: z.boolean().nullable(),
		licence: z.string().nullable(),
		licenceUrl: z.string().nullable(),
		attribution: z.string().nullable(),
		panelSources: z.array(z.string()),
	})
	.meta({ description: "Una cifra de un panel con su procedencia." });

export const PanelSummary = z.object({
	id: z.string(),
	sources: z.array(z.string()),
	links: z.object({ self: z.string(), figures: z.string(), csv: z.string() }),
});

const envelope = <T extends z.ZodRawShape>(shape: T) =>
	z.object({
		apiVersion: z.literal(API_VERSION),
		generatedAt: ms("Cuándo se generó esta respuesta"),
		...shape,
	});

export const IndexResponse = envelope({
	name: z.string(),
	version: z.string().meta({ description: "Versión de Vigía." }),
	mode: z.enum(["local", "public"]),
	docs: z.string(),
	openapi: z.string(),
	endpoints: z.array(z.object({ path: z.string(), summary: z.string() })),
});

export const SourcesResponse = envelope({ sources: z.array(Source) });

export const SourceResponse = envelope({ source: Source, health: Health });

export const HealthResponse = envelope({
	counts: z.record(z.string(), z.number().int()).meta({ description: "Fuentes por estado." }),
	feeds: z.array(Health),
});

export const PanelsResponse = envelope({ panels: z.array(PanelSummary) });

export const PanelResponse = envelope({
	id: z.string(),
	sources: z.array(z.string()),
	panel: JsonValue.meta({
		description:
			"La vista del panel tal como la calculó Vigía (la misma que dibuja la página). Su forma es propia de cada panel.",
	}),
});

export const FiguresResponse = envelope({
	figures: z.array(Figure),
	truncated: z.boolean().meta({ description: "true si se alcanzó el máximo de filas." }),
});

export const SeriesListResponse = envelope({
	source: z.string(),
	observations: z.array(Observation).meta({ description: "La observación más reciente de cada serie." }),
});

export const SeriesResponse = envelope({
	source: z.string(),
	series: z.string(),
	from: ms("Inicio de la ventana"),
	to: ms("Fin de la ventana"),
	observations: z
		.array(Observation)
		.meta({ description: "Cada revisión guardada, de la más vieja a la más nueva." }),
	truncated: z.boolean(),
});

export const IncidentsResponse = envelope({
	asOf: z.number().int(),
	counts: z.record(z.string(), z.number().int()),
	incidents: z.array(JsonValue).meta({ description: "Incidentes activos y recientes, con su evidencia." }),
	rules: z.object({ es: z.array(z.string()), en: z.array(z.string()) }),
});

export const IncidentResponse = envelope({
	incident: JsonValue,
	history: z.array(JsonValue).meta({ description: "Una línea por revisión archivada (la cronología)." }),
	rules: z.object({ es: z.array(z.string()), en: z.array(z.string()) }),
});

export const ConnectivityHistoryResponse = envelope({
	history: z
		.object({
			layer: z.literal("connectivity"),
			from: z.number().int(),
			to: z.number().int(),
			stepMs: z.number().int(),
			step: z.enum(["1h", "6h", "1d"]),
			times: z.array(z.number().int()),
			states: z.record(z.string(), z.string()).meta({
				description: "Estado ISO → un carácter por paso: n normal, d caída, s severa, x sin datos.",
			}),
			counts: z.array(
				z.object({
					normal: z.number().int(),
					drop: z.number().int(),
					severe: z.number().int(),
					noData: z.number().int(),
				}),
			),
			firstJudgedAt: z.number().int().nullable(),
			computedAt: z.number().int(),
			rule: Bilingual,
			feed: z.string(),
			attribution: z.string(),
			licence: z.string(),
			sourceUrl: z.string(),
		})
		.meta({ description: "Reconstrucción hora a hora con las reglas del panel de conectividad (derivada)." }),
});

export const DigestsResponse = envelope({
	format: z.string(),
	method: z.string(),
	head: JsonValue.nullable(),
	entries: z.array(JsonValue),
});

export const ErrorResponse = z
	.object({
		error: z.string().meta({ description: "Mensaje en español para una persona." }),
		code: z.string().optional(),
	})
	.meta({ description: "Error: un mensaje claro en español." });
