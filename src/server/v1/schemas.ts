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
		note: Bilingual.nullable().meta({
			description: "Encendida por defecto, con una nota sobre cómo la lee Vigía (se puede apagar).",
		}),
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

// ——— entities (src/ontology/view.ts holds the same shapes as plain types for the client) ———

const EntityType = z
	.enum([
		"country",
		"state",
		"municipality",
		"parish",
		"infrastructure",
		"network",
		"outlet",
		"institution",
		"camera",
	])
	.meta({ description: "Tipo de entidad." });

const FigureValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const EntityRef = z
	.object({
		id: z.string().meta({
			description: "Identificador estable y legible: ve.zulia.maracaibo, infra.planta-centro, asn.8048…",
		}),
		type: EntityType,
		kind: z.string().nullable().meta({
			description: "Subtipo: tipo de instalación, isp/asn, postura del medio o tipo de institución.",
		}),
		name: Bilingual,
		short: z.string().nullable(),
		href: z.string().meta({ description: "Ruta de la entidad en la API." }),
	})
	.meta({ description: "Referencia a una entidad." });

const DatasetRef = z
	.object({
		id: z.string(),
		name: z.string(),
		url: z.string(),
		licence: z.object({ id: z.string(), name: z.string(), url: z.string() }),
		attribution: z.string(),
		retrieved: z.string(),
	})
	.meta({ description: "De dónde vienen los datos de la entidad misma, con su licencia." });

export const EntityDetail = EntityRef.extend({
	aliases: z.array(z.string()),
	point: z.object({ lat: z.number(), lon: z.number() }).nullable(),
	geometry: z
		.string()
		.nullable()
		.meta({ description: "Dónde está su geometría (cod-ab:VE0101, osm:way/…)." }),
	codes: z
		.record(z.string(), z.string())
		.meta({ description: "Códigos externos: código P, ISO, ASN, IATA, OSM…" }),
	attributes: z.record(z.string(), JsonValue),
	related: z.array(
		z.object({ rel: z.enum(["operator", "network-of", "publishes", "attached-to"]), entity: EntityRef }),
	),
	dataset: DatasetRef,
}).meta({ description: "Una entidad con sus atributos y la fuente de sus datos." });

const FigureSource = z.object({
	feed: z.string().nullable().meta({ description: "Fuente (adaptador); null si la cifra suma varias." }),
	name: z.string(),
	sourceUrl: z.string().nullable(),
	licence: z.string(),
	attribution: z.string(),
});

export const NowItem = z
	.object({
		layer: z.string(),
		scope: EntityRef.meta({
			description:
				"La entidad de la que habla la cifra: esta, o un ancestro si la fuente mide a nivel de estado.",
		}),
		label: Bilingual,
		text: Bilingual,
		figures: z.record(z.string(), FigureValue),
		source: FigureSource,
		observedAt: msOrNull("Cuándo la fuente dice que es cierto"),
		fetchedAt: msOrNull("Cuándo Vigía lo recibió"),
		stale: z
			.boolean()
			.meta({ description: "La fuente superó su presupuesto de frescura, o el dato es viejo." }),
		basis: z.enum(["measurement", "official", "quote", "report", "derived"]),
		computed: z.boolean().meta({ description: "true: calculado por Vigía (conteo, suma, comparación)." }),
		method: z.string().nullable(),
	})
	.meta({ description: "Una señal viva sobre la entidad, con su fuente, horas y frescura." });

const PopulationView = z
	.object({
		census2011: z
			.object({ people: z.number(), source: z.string(), licence: z.string(), note: z.string() })
			.nullable(),
		worldpop2026: z
			.object({ people: z.number(), source: z.string(), licence: z.string(), note: z.string() })
			.nullable(),
		computed: z.boolean(),
		method: z.string(),
	})
	.meta({ description: "Población según dos fuentes, lado a lado (nunca mezcladas)." });

const PopulationInAreaView = z
	.object({
		area: Bilingual,
		people: z.number(),
		radii: z.array(z.object({ km: z.number(), people: z.number() })).nullable(),
		basis: z.literal("estimate"),
		source: z.string(),
		licence: z.string(),
		note: z.string(),
		computed: z.literal(true),
		method: z.string(),
		caveat: Bilingual,
	})
	.meta({
		description:
			"Personas que viven en el área de un incidente corroborado: una estimación modelada (WorldPop) calculada por Vigía; nunca personas afectadas ni sin servicio.",
	});

const IncidentBrief = z.object({
	id: z.string(),
	kind: z.string(),
	title: Bilingual,
	status: z.enum(["active", "ended"]),
	tier: z.enum(["incident", "watch"]),
	corroboration: z.number().int(),
	families: z.array(z.string()),
	reportsOnly: z.boolean(),
	startAt: z.number().int(),
	lastEvidenceAt: z.number().int(),
	scope: EntityRef.nullable(),
	populationInArea: PopulationInAreaView.nullable(),
	href: z.string(),
});

const StoryBrief = z.object({
	title: z.string(),
	url: z.string(),
	at: z.number().int(),
	fetchedAt: z.number().int(),
	outlet: EntityRef.nullable(),
	outletName: z.string(),
	storyId: z.string().nullable(),
	outlets: z.number().int(),
	rule: z.string().meta({ description: "Cómo se vinculó (text-place = ubicación por palabra clave)." }),
	confidence: z.number(),
});

const NearbyItem = z.object({
	entity: EntityRef,
	km: z.number(),
	relation: z.enum(["inside", "near"]),
});

const LinkRules = z.object({ es: z.array(z.string()), en: z.array(z.string()) });

const ExplainedBy = z
	.object({ id: z.string(), title: Bilingual, tier: z.enum(["incident", "watch"]), href: z.string() })
	.nullable()
	.meta({ description: "Un incidente abierto (o recién terminado) en el mismo lugar que ya lo explica." });

const AnomalyMember = z.object({
	entity: EntityRef,
	changePct: z.number().nullable(),
	score: z.number(),
	onsetAt: z.number().int(),
	observedAt: z.number().int(),
	explainedBy: ExplainedBy,
});

export const AnomalyItem = z
	.object({
		id: z.string(),
		title: Bilingual,
		entity: EntityRef,
		metric: z.object({
			id: z.string(),
			label: Bilingual,
			unit: Bilingual.nullable(),
			class: z
				.string()
				.meta({ description: "Ritmo de la línea base: connectivity, night, change, level, count, hourly." }),
		}),
		direction: z.enum(["up", "down"]),
		value: z.number().nullable().meta({
			description:
				"El dato más reciente, en la unidad de la métrica; null en fuentes cuyos términos no permiten redistribuir sus datos (IODA).",
		}),
		baseline: z.number().nullable().meta({ description: "Lo que la línea base espera; null como value." }),
		changePct: z.number().nullable(),
		score: z.number().meta({ description: "z robusta con signo; la lista se ordena por su valor absoluto." }),
		tail: z
			.number()
			.nullable()
			.meta({ description: "Solo conteos: P(X ≥ valor) de Poisson con la línea base." }),
		window: z.object({
			text: Bilingual,
			points: z.number().int(),
			from: msOrNull("Inicio de la ventana de la línea base"),
			to: msOrNull("Fin de la ventana de la línea base"),
		}),
		rule: Bilingual,
		source: FigureSource,
		observedAt: z.number().int(),
		fetchedAt: msOrNull("Cuándo Vigía lo recibió"),
		ageMs: z.number().int(),
		explainedBy: ExplainedBy,
		figures: z.record(z.string(), FigureValue),
		members: z.array(AnomalyMember).nullable().meta({
			description:
				"Hecho regional: estados cuyas caídas empezaron juntas, cada uno con su propia cifra (nunca una combinada).",
		}),
		groupId: z
			.string()
			.nullable()
			.meta({ description: "En una lectura por estado: el hecho regional que la agrupa." }),
		reverted: z
			.object({
				afterSteps: z.number().int(),
				at: z.number().int(),
				date: z.string(),
				value: z.number().nullable(),
				text: Bilingual,
			})
			.nullable()
			.meta({
				description: "La serie publicada deshizo este movimiento N datos después (un hecho de la serie).",
			}),
		computed: z.literal(true),
		method: z.string(),
		basis: z.literal("derived"),
	})
	.meta({
		description: "Una lectura inusual frente a su propia historia, calculada por Vigía con una regla fija.",
	});

const ClassCount = z.object({
	series: z.number().int(),
	judged: z.number().int(),
	unusual: z.number().int(),
});

export const AnomaliesResponse = envelope({
	asOf: z.number().int(),
	version: z.number().int(),
	items: z.array(AnomalyItem),
	truncated: z.boolean(),
	grouped: z.array(AnomalyItem),
	counts: z.object({
		series: z.number().int(),
		judged: z.number().int(),
		unusual: z.number().int(),
		explained: z.number().int(),
		regions: z.number().int(),
		grouped: z.number().int(),
		reverted: z.number().int(),
		thin: z.number().int(),
		stale: z.number().int(),
		weak: z.number().int(),
		byClass: z.record(z.string(), ClassCount),
		judgedByEntity: z.record(z.string(), z.number().int()),
	}),
	rules: LinkRules,
});

export const EntityResponse = envelope({
	entity: EntityDetail,
	parents: z.array(EntityRef).meta({ description: "Ancestros, del más cercano al país." }),
	children: z.object({
		total: z.number().int(),
		byType: z.record(z.string(), z.number().int()),
		items: z.array(EntityRef),
		truncated: z.boolean(),
	}),
	now: z.array(NowItem),
	incidents: z.array(IncidentBrief),
	stories: z.array(StoryBrief),
	nearby: z.object({
		rule: Bilingual,
		order: z.enum(["distance", "kind"]).meta({
			description:
				"distance: la más cercana al punto de la entidad primero (a igual distancia, por tipo); kind: por tipo, cuando la entidad no tiene punto propio.",
		}),
		byKind: z.record(z.string(), z.number().int()),
		items: z.array(NearbyItem),
		truncated: z.boolean(),
	}),
	population: PopulationView.nullable(),
	anomalies: z.array(AnomalyItem).meta({
		description: "Lo inusual ahora sobre la entidad o un ancestro (su estado), mayor puntuación primero.",
	}),
	anomaliesJudged: z.number().int().meta({
		description:
			"Series juzgadas ahora sobre la entidad o su estado; 0 = sin datos para juzgar, no «nada inusual».",
	}),
	links: z.object({
		timeline: z.string(),
		rules: LinkRules,
		backlog: z.number().int().meta({ description: "Observaciones archivadas aún sin vincular." }),
	}),
	asOf: z.number().int(),
});

const TimelineItem = z.object({
	at: z.number().int(),
	kind: z.string(),
	title: Bilingual,
	source: FigureSource,
	url: z.string(),
	observedAt: z.number().int(),
	fetchedAt: z.number().int(),
	rule: z.string(),
	confidence: z.number(),
	km: z.number().nullable(),
	figures: z
		.record(z.string(), FigureValue)
		.nullable()
		.meta({ description: "Solo de fuentes cuyos términos permiten pasar sus cifras; null en las demás." }),
});

export const TimelineResponse = envelope({
	entity: EntityRef,
	from: z.number().int(),
	to: z.number().int(),
	items: z.array(TimelineItem),
	truncated: z.boolean(),
	rules: LinkRules,
	backlog: z.number().int(),
});

export const EntitySearchResponse = envelope({
	query: z.string(),
	type: EntityType.nullable(),
	truncated: z.boolean().meta({ description: "Hay más resultados que limit." }),
	results: z.array(
		z.object({ entity: EntityRef, parent: EntityRef.nullable(), score: z.number(), matched: z.string() }),
	),
});

export const LocateResponse = envelope({
	lat: z.number(),
	lon: z.number(),
	places: z.array(EntityRef),
	how: z.enum(["inside", "lake", "outside"]),
	near: z.array(NearbyItem),
	radiusKm: z.number(),
});

// ——— stills: the time machine's pictures (src/panels/stills.ts holds the same shapes) ———

export const StillImage = z
	.object({
		url: z.string().meta({ description: "Imagen en este mismo servidor (/api/blobs/…)." }),
		width: z.number().int(),
		height: z.number().int(),
		takenAt: ms("Cuándo Vigía tomó o leyó la imagen"),
		source: z.enum(["tv-frame", "youtube-thumbnail", "youtube-cover", "camera"]),
		labelEs: z.string(),
		labelEn: z.string(),
	})
	.meta({
		description: "Una imagen fija con su hora. Pasada la retención de su fuente, la URL responde 404.",
	});

const CameraStatus = z.enum(["live", "frozen", "down", "stale", "no-stills", "locked", "unmeasured"]);

export const StillsResponse = envelope({
	at: ms("El momento pedido"),
	tv: z.array(
		z.object({
			entry: z.string(),
			channel: z.string(),
			name: z.string(),
			image: StillImage.nullable(),
			whyEs: z.string().nullable(),
		}),
	),
	youtube: z.array(z.object({ channel: z.string(), name: z.string(), image: StillImage.nullable() })),
	cameras: z.array(
		z.object({
			id: z.string(),
			entity: z.string().nullable(),
			name: Bilingual,
			lat: z.number(),
			lon: z.number(),
			headingDeg: z.number().nullable(),
			status: CameraStatus,
			image: StillImage.nullable(),
			night: z.object({ status: z.string(), ratio: z.number().nullable() }),
		}),
	),
	rulesEs: z.string(),
	rulesEn: z.string(),
});

export const CameraStillsResponse = envelope({
	camera: z.string(),
	from: ms("Desde"),
	to: ms("Hasta"),
	truncated: z.boolean(),
	stills: z.array(
		z.object({
			url: z.string().nullable(),
			takenAt: ms("Cuándo Vigía la tomó"),
			reason: z.string().nullable().meta({ description: "Por qué esa ronda no tiene imagen." }),
			night: z.boolean(),
			lit: z.number().nullable().meta({ description: "Parte de la zona de luces encendida (0–1)." }),
			lumaMean: z.number().nullable(),
		}),
	),
});
