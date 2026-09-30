/**
 * The words of the entity page's signals table and its header strip, from the server's linked view
 * (`/api/v1/entities/{id}`): a short name for each signal ("Internet", "Rayos, 24 h"), its source's short name
 * ("IODA"), the comparison with its own normal where the server sends one ("62 % · sondeo"), one quiet line of
 * context ("el mayor M4,7"), and, for a signal with nothing to say right now, why ("nublado"), so the table can fold
 * it into one line. The header's key facts: population (census and WorldPop apart), area, capital or operator or
 * capacity by type, open incidents and unusual readings, each with its source.
 *
 * Nothing is computed here: every figure is one the server sent, picked and worded. Loaded with the entity pages and
 * the inspector, never in the first load.
 */
import type { EntityView as ApiView, NowItem } from "../../../src/ontology/view.ts";
import { int, type Lang, num } from "./format.ts";

const tr = (l: Lang, es: string, en: string) => (l === "es" ? es : en);

function n(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** What the table says about one signal, besides its value (lib/entity-api.ts `leadOf`). */
export interface SignalWords {
	/** Short name: "Internet", "Probables incendios, 24 h". */
	name: string;
	/** The source's short name: "IODA", "NASA FIRMS". */
	source: string;
	/** Against its own normal, as the server gives it: "62 % · sondeo", "×1,4". */
	vs?: string;
	/** One quiet line under the name: "el mayor M4,7", "0 en la última hora". */
	context?: string;
	/** Nothing to say right now, and why ("sin datos suficientes", "nublado"): folded into one line. */
	silent?: string;
	/** Every part behind the value, for the opened row ("BGP 98 % · sondeo 62 % · telescopio 97 %"). */
	breakdown?: string;
}

/** The IODA signals in short words. */
const IODA_SIGNAL: Record<string, { es: string; en: string }> = {
	bgp: { es: "BGP", en: "BGP" },
	"ping-slash24": { es: "sondeo", en: "probing" },
	"merit-nt": { es: "telescopio", en: "telescope" },
};

const NAME: Record<string, { es: string; en: string }> = {
	connectivity: { es: "Internet", en: "Internet" },
	probes: { es: "Sondas RIPE Atlas", en: "RIPE Atlas probes" },
	nightlights: { es: "Luz nocturna", en: "Night light" },
	quakes: { es: "Sismos, 30 días", en: "Quakes, 30 days" },
	lightning: { es: "Rayos, 24 h", en: "Lightning, 24 h" },
	gdelt: { es: "Prensa mundial, 24 h", en: "World press, 24 h" },
	broadcast: { es: "TV y radio del directorio", en: "TV and radio in the directory" },
	sanctions: { es: "Sanciones de EE. UU. (SDN)", en: "US sanctions (SDN)" },
	markets: { es: "Mercados de predicción", en: "Prediction markets" },
	flares: { es: "Quema de gas", en: "Gas flaring" },
	"port-calls": { es: "Escalas de buques", en: "Port calls" },
	reservoir: { es: "Nivel del embalse", en: "Reservoir level" },
	censorship: { es: "Sitios bloqueados", en: "Blocked sites" },
	routing: { es: "Cambios de rutas", en: "Routing changes" },
	gazette: { es: "Gacetas con actos suyos, 30 días", en: "Gazettes with its acts, 30 days" },
};

const SOURCE: Record<string, string> = {
	connectivity: "IODA",
	probes: "RIPE Atlas",
	nightlights: "NASA VIIRS",
	weather: "Open-Meteo",
	fires: "NASA FIRMS",
	quakes: "USGS · FUNVISIS",
	lightning: "GOES-19 GLM",
	gdelt: "GDELT",
	broadcast: "iptv-org · Radio Browser",
	office: "Wikidata",
	sanctions: "OFAC",
	markets: "Polymarket · Kalshi",
	flares: "NASA FIRMS",
	"port-calls": "IMF PortWatch",
	reservoir: "DAHITI",
	censorship: "OONI · VE sin Filtro",
	routing: "RIPE RIS",
	gazette: "Gaceta Oficial",
};

/** "Tipo de cambio oficial (BCV)" → "BCV"; a long or absent bracket keeps the whole name. */
function shortSource(name: string): string {
	const m = /\(([^()]{1,24})\)\s*$/.exec(name);
	return m?.[1] ?? name;
}

/** A trailing bracket that is a unit ("(Bs.)", "(%)", "(MM US$)", "(Bs. por euro)"). */
const UNIT_BRACKET = /^(Bs\.( por (dólar|euro))?|%|MM US\$|US\$)$/;

/** "Tasa oficial del dólar (Bs.)" → name "Tasa oficial del dólar"; "INPC (índice, base …)" → "INPC" + context. */
function splitLabel(label: string): { name: string; bracket: string | null } {
	const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(label);
	return m?.[1] ? { name: m[1], bracket: m[2] ?? null } : { name: label, bracket: null };
}

/** The same label without its source in brackets ("Presidente del BCV (Wikidata)" → "Presidente del BCV"). */
function withoutSource(label: string): string {
	return splitLabel(label).name;
}

const DAY = {
	es: new Intl.DateTimeFormat("es", {
		timeZone: "America/Caracas",
		day: "numeric",
		month: "short",
		year: "numeric",
	}),
	en: new Intl.DateTimeFormat("en", {
		timeZone: "America/Caracas",
		day: "numeric",
		month: "short",
		year: "numeric",
	}),
};

/** "25 sept 2026" in Caracas. */
function caracasDay(at: number, l: Lang): string {
	return DAY[l].format(at).replace(/\./g, "");
}

function signed(v: number, digits: number, l: Lang): string {
	return `${v > 0 ? "+" : v < 0 ? "−" : ""}${num(Math.abs(v), digits, l)}`;
}

/** The words of one "now" item in the signals table. */
export function signalWords(item: NowItem, l: Lang, entityType = "state"): SignalWords {
	const f = item.figures;
	const label = item.label[l];
	const source = SOURCE[item.layer] ?? shortSource(item.source.name);
	const base: SignalWords = { name: NAME[item.layer]?.[l] ?? withoutSource(label), source };
	switch (item.layer) {
		case "connectivity": {
			if (f.level === "no-data")
				return { ...base, silent: tr(l, "sin datos suficientes", "not enough data") };
			// The lowest signal against its own normal: the one the level rests on (all three open with the row).
			let low: { sig: string; p: number } | null = null;
			const parts: string[] = [];
			for (const sig of Object.keys(IODA_SIGNAL)) {
				const p = n(f[`${sig}PctOfBaseline`]);
				const word = IODA_SIGNAL[sig]?.[l] ?? sig;
				parts.push(`${word} ${p === null ? tr(l, "sin dato", "no data") : `${num(p, 0, l)} %`}`);
				if (p !== null && (!low || p < low.p)) low = { sig, p };
			}
			return low
				? {
						...base,
						vs: `${num(low.p, 0, l)} % · ${IODA_SIGNAL[low.sig]?.[l] ?? low.sig}`,
						breakdown: tr(
							l,
							`Cada señal frente a su nivel habitual a esta hora: ${parts.join(" · ")}.`,
							`Each signal against its usual level at this hour: ${parts.join(" · ")}.`,
						),
					}
				: base;
		}
		case "probes": {
			const d = n(f.droppedLastHour);
			return d === null
				? base
				: { ...base, context: tr(l, `${int(d, l)} desconectadas en 1 h`, `${int(d, l)} dropped in 1 h`) };
		}
		case "nightlights": {
			if (f.comparable !== true || n(f.pctChange) === null) {
				const clear = n(f.clearFraction);
				return {
					...base,
					silent:
						f.quality === "cloudy"
							? clear !== null
								? tr(
										l,
										`nublado, ${num(clear * 100, 0, l)} % despejado`,
										`cloudy, ${num(clear * 100, 0, l)} % clear`,
									)
								: tr(l, "nublado", "cloudy")
							: tr(l, "sin comparar esta noche", "not compared tonight"),
				};
			}
			// The value is itself the comparison: the column says so rather than "no comparison".
			return {
				...base,
				vs: tr(l, "es el valor", "is the value"),
				context: tr(
					l,
					"frente a la mediana de sus noches despejadas",
					"against the median of its clear nights",
				),
			};
		}
		case "weather": {
			const rain = n(f.next24hPrecipMm);
			const feel = n(f.apparentC);
			const parts = [
				feel !== null ? tr(l, `sensación ${num(feel, 0, l)}°`, `feels ${num(feel, 0, l)}°`) : null,
				rain !== null
					? tr(l, `lluvia 24 h: ${num(rain, 1, l)} mm`, `rain 24 h: ${num(rain, 1, l)} mm`)
					: null,
			].filter(Boolean);
			return { ...base, name: withoutSource(label), ...(parts.length ? { context: parts.join(" · ") } : {}) };
		}
		case "fires": {
			const likely = n(f.likelyFires24h);
			if (likely !== null) {
				const all = n(f.last24h);
				const pers = n(f.persistent24h);
				return {
					...base,
					name: tr(l, "Probables incendios, 24 h", "Likely fires, 24 h"),
					...(all !== null && all > 0
						? {
								context: tr(
									l,
									`de ${int(all, l)} focos de calor${pers ? `; ${int(pers, l)} en fuentes persistentes` : ""}`,
									`of ${int(all, l)} heat detections${pers ? `; ${int(pers, l)} at persistent sources` : ""}`,
								),
							}
						: {}),
				};
			}
			if (n(f.detectionsNear48h) !== null)
				return {
					...base,
					name: tr(l, "Focos de calor cerca, 48 h", "Heat detections nearby, 48 h"),
					context: tr(l, "dentro de la distancia de la regla", "within the rule's distance"),
				};
			return {
				...base,
				name: tr(l, "Focos de calor, 48 h", "Heat detections, 48 h"),
				...(n(f.detections48h)
					? { context: tr(l, "incluye fuentes persistentes", "persistent sources included") }
					: {}),
			};
		}
		case "quakes": {
			const m = n(f.strongestMag);
			return m === null
				? base
				: { ...base, context: tr(l, `el mayor M${num(m, 1, l)}`, `strongest M${num(m, 1, l)}`) };
		}
		case "news": {
			const h = n(f.headlines48h) !== null ? 48 : 24;
			return {
				...base,
				name: tr(l, `Titulares, ${h} h`, `Headlines, ${h} h`),
				source: entityType === "outlet" ? tr(l, "sus feeds", "its feeds") : tr(l, "Medios", "Outlets"),
			};
		}
		case "lightning": {
			const h = n(f.flashes1h);
			return h === null
				? base
				: {
						...base,
						// Out of date, "the last hour" is the last hour the source measured, not this one.
						context:
							(item.stale
								? tr(l, `${int(h, l)} en su última hora medida`, `${int(h, l)} in its last measured hour`)
								: tr(l, `${int(h, l)} en la última hora`, `${int(h, l)} in the last hour`)) +
							(entityType === "infrastructure" ? tr(l, ", en su celda de 0,25°", ", in its 0.25° cell") : ""),
					};
		}
		case "office": {
			const status = String(f.status ?? "");
			const word =
				status === "current"
					? tr(l, "en el cargo según Wikidata", "in office per Wikidata")
					: status === "ended"
						? tr(l, "período terminado; sin sucesor en Wikidata", "term ended; no successor in Wikidata")
						: tr(l, "Wikidata no da fecha de fin", "Wikidata gives no end date");
			if (typeof f.holder !== "string" || !f.holder)
				return { ...base, silent: tr(l, "sin titular en Wikidata", "no holder in Wikidata") };
			// A term that ended is never shown as the current holder: the value says there is none on record.
			if (status === "ended")
				return {
					...base,
					context: tr(
						l,
						`último: ${f.holder}${typeof f.end === "string" ? `, hasta ${f.end}` : ""}; Wikidata no registra sucesor`,
						`last: ${f.holder}${typeof f.end === "string" ? `, until ${f.end}` : ""}; Wikidata records no successor`,
					),
				};
			return { ...base, context: word };
		}
		case "sanctions":
			if (f.listed === null || f.listed === undefined)
				return { ...base, silent: tr(l, "lista aún sin leer", "list not read yet") };
			return typeof f.programs === "string" && f.programs ? { ...base, context: f.programs } : base;
		case "markets":
			return { ...base, context: tr(l, "un precio no es un pronóstico", "a price is not a forecast") };
		case "flares": {
			if (f.status === "no-data") return { ...base, silent: tr(l, "sin datos", "no data") };
			const r = n(f.ratioToBaseline);
			const nights = n(f.activeNights7d);
			return {
				...base,
				...(r !== null ? { vs: `×${num(r, 1, l)}` } : {}),
				...(nights !== null
					? {
							context: tr(
								l,
								`quema en ${int(nights, l)} de 7 noches`,
								`flaring on ${int(nights, l)} of 7 nights`,
							),
						}
					: {}),
			};
		}
		case "port-calls": {
			const tankers = n(f.tankerCalls);
			return {
				...base,
				context: [
					typeof f.date === "string" ? tr(l, `el ${f.date}`, `on ${f.date}`) : null,
					tankers !== null ? tr(l, `${int(tankers, l)} de tanqueros`, `${int(tankers, l)} tankers`) : null,
					tr(l, "sin AIS no cuenta", "AIS-off not counted"),
				]
					.filter(Boolean)
					.join(" · "),
			};
		}
		case "reservoir": {
			const d = n(f.change30dM);
			return {
				...base,
				context:
					tr(l, "satelital, no es la cota oficial", "satellite, not the official gauge") +
					(d !== null
						? tr(l, ` · ${signed(d, 2, l)} m en 30 días`, ` · ${signed(d, 2, l)} m in 30 days`)
						: ""),
			};
		}
		case "censorship": {
			const flagged = n(f.ooniFlagged);
			const tested = n(f.ooniTested);
			const vsf = n(f.vsfBlocked);
			// Only the sources whose figure is present.
			const named = [vsf !== null ? "VE sin Filtro" : null, flagged !== null ? "OONI" : null].filter(Boolean);
			return {
				...base,
				source: named.length ? named.join(" · ") : base.source,
				...(vsf !== null && flagged !== null
					? {
							context: tr(
								l,
								`VE sin Filtro; OONI: ${int(flagged, l)}${tested !== null ? ` de ${int(tested, l)}` : ""} con anomalías`,
								`VE sin Filtro; OONI: ${int(flagged, l)}${tested !== null ? ` of ${int(tested, l)}` : ""} flagged`,
							),
						}
					: {}),
			};
		}
		case "routing":
			return {
				...base,
				context: tr(l, "por encima de la regla, en la ventana", "above the rule, in the window"),
			};
		case "feed": {
			if (f.state === "pending" || f.state === "off" || f.state === "locked")
				return {
					...base,
					silent:
						f.state === "locked"
							? tr(l, "necesita una clave", "needs a key")
							: f.state === "off"
								? tr(l, "apagado", "off")
								: tr(l, "pendiente", "pending"),
				};
			// The newest publication read, as a Caracas date (the server's sentence gives the UTC date).
			const at = n(f.newestObservedAt) ?? item.observedAt;
			return {
				...base,
				name: label,
				...(at !== null
					? {
							context: tr(
								l,
								`última publicación: ${caracasDay(at, l)}`,
								`last published: ${caracasDay(at, l)}`,
							),
						}
					: {}),
			};
		}
		case "figure": {
			const { name, bracket } = splitLabel(label);
			const context = bracket && !UNIT_BRACKET.test(bracket) ? bracket : undefined;
			return { ...base, name, ...(context ? { context } : {}) };
		}
		case "crowd":
			return {
				...base,
				name: label,
				source: tr(l, "Usuarios de Vigía", "Vigía users"),
				context: tr(l, "reportes de usuarios, sin verificar", "user reports, unverified"),
			};
	}
	return base;
}

/** A figure's unit taken from its label's bracket ("(MM US$)", "(Bs. por euro)"), when it is one. */
export function unitOfLabel(label: string): string | null {
	const { bracket } = splitLabel(label);
	return bracket && UNIT_BRACKET.test(bracket) && bracket !== "%" ? bracket : null;
}

// ——— the header strip ———

/** One key fact in the header strip: a short label, a figure or a few words, and whose it is. */
export interface KeyFact {
	key: string;
	label: string;
	value: string;
	unit?: string;
	/** Who says it, in a few words, always shown under the value ("INE, censo", "modelo WorldPop"). */
	source: string;
	/** The whole provenance and caveat, shown when the fact is pressed (and on hover). */
	note: string;
	/** A section of the page this fact summarises (its element id): the fact is a jump there. */
	jump?: string;
	/** Another entity it names (an operator): the value links to its page. */
	entity?: string;
	/** Vigía's own count, said so. */
	computed?: boolean;
	/** An outside address the value opens (a website). */
	url?: string;
	/**
	 * A live count whose inputs can be out of date: the page checks their freshness (the incidents panel's feeds, the
	 * entity's own signals) and says "sin datos recientes" rather than a confident zero (`liveValue`).
	 */
	live?: "incidents" | "unusual";
	/** For "unusual": how many series about the entity the engine judged now (0: nothing to judge by). */
	judged?: number;
}

/** "estado Zulia", "Distrito Capital", "municipio Maracaibo", "Venezuela": an ancestor as a phrase after "del"/"de". */
export function scopePhrase(
	r: { type: string; name: { es: string; en: string }; short?: string | null },
	l: Lang,
): string {
	const name = r.name[l];
	if (r.type === "state")
		return /^(Distrito Capital|Dependencias Federales)$/.test(r.name.es)
			? name
			: tr(l, `estado ${name}`, `${name} state`);
	if (r.type === "municipality") return tr(l, `municipio ${name}`, `${name} municipality`);
	if (r.type === "parish") return tr(l, `parroquia ${name}`, `${name} parish`);
	return r.short ?? name;
}

/** "del estado Zulia", "de Venezuela", "de CANTV": whose a figure is. */
export function ofScope(
	r: { type: string; name: { es: string; en: string }; short?: string | null },
	l: Lang,
): string {
	const phrase = scopePhrase(r, l);
	if (l === "en") return `of ${phrase}`;
	return r.type === "state" || r.type === "municipality" || r.type === "parish"
		? `del ${phrase}`
		: `de ${phrase}`;
}

/**
 * A live key fact under its inputs' freshness: a zero from out-of-date inputs is not an answer ("—", "sin datos
 * recientes"); another count keeps its figure and says it is out of date.
 */
export function liveValue(
	k: KeyFact,
	stale: boolean,
	l: Lang,
): { value: string; source: string; stale: boolean } {
	if (!stale) return { value: k.value, source: k.source, stale: false };
	if (k.value === "0")
		return {
			value: "—",
			source: tr(l, "sin datos recientes para juzgar", "no recent data to judge"),
			stale: true,
		};
	return { value: k.value, source: k.source, stale: true };
}

const INFRA_SOURCE: Record<string, { es: string; en: string }> = {
	hydro: { es: "hidroeléctrica", en: "hydro" },
	gas: { es: "gas", en: "gas" },
	"fuel oil": { es: "fueloil", en: "fuel oil" },
	oil: { es: "petróleo", en: "oil" },
	diesel: { es: "diésel", en: "diesel" },
	solar: { es: "solar", en: "solar" },
	wind: { es: "eólica", en: "wind" },
	thermal: { es: "térmica", en: "thermal" },
};

/**
 * The header strip's facts, by type, at most six: a place's people (census 2011 and WorldPop 2026 side by side,
 * never one number), area and capital; a facility's capacity, operator and kind; a network's systems and service;
 * an institution's or outlet's attachment and reach; and, where the ontology links them, open incidents and unusual
 * readings (each a jump to its section).
 */
export function keyFacts(v: ApiView, l: Lang): KeyFact[] {
	const e = v.entity;
	const a = e.attributes;
	const out: KeyFact[] = [];
	const place =
		e.type === "country" || e.type === "state" || e.type === "municipality" || e.type === "parish";
	const dataset = e.dataset;
	const ds = `${dataset.attribution} (${dataset.licence.name})`;
	if (place) {
		const p = v.population;
		// A state's or the country's census is Vigía's sum of INE's municipal figures; a municipality's is INE's own.
		// WorldPop is always Vigía's sum of the model's grid cells.
		const summed = e.type === "state" || e.type === "country";
		if (p?.census2011)
			out.push({
				key: "census",
				label: tr(l, "Censo 2011", "Census 2011"),
				value: int(p.census2011.people, l),
				source: tr(l, "habitantes · INE", "people · INE"),
				note:
					`${p.census2011.source} (${p.census2011.licence}). ${p.census2011.note}` +
					(summed
						? tr(
								l,
								" Suma de sus municipios, calculada por Vigía.",
								" The sum of its municipalities, computed by Vigía.",
							)
						: ""),
				...(summed ? { computed: true } : {}),
			});
		if (p?.worldpop2026)
			out.push({
				key: "worldpop",
				label: tr(l, "Estimación 2026", "Estimate 2026"),
				value: int(p.worldpop2026.people, l),
				source: tr(l, "habitantes · WorldPop (modelo)", "people · WorldPop (model)"),
				note: `${p.worldpop2026.source} (${p.worldpop2026.licence}). ${p.worldpop2026.note} ${tr(l, "Se muestra al lado del censo, nunca mezclada con él.", "Shown beside the census, never blended with it.")} ${tr(l, "Calculado por Vigía:", "Computed by Vigía:")} ${p.method}`,
				computed: true,
			});
		const area = n(a.areaKm2);
		if (area !== null)
			out.push({
				key: "area",
				label: tr(l, "Superficie", "Area"),
				value: num(area, area < 10 ? 1 : 0, l),
				unit: "km²",
				source: tr(l, "límites COD-AB", "COD-AB boundaries"),
				note:
					`${dataset.name}. ${ds}.` +
					(e.type === "country"
						? tr(
								l,
								" Suma de las superficies de sus entidades federales, calculada por Vigía.",
								" The sum of its federal entities' areas, computed by Vigía.",
							)
						: tr(l, " Superficie que da OCHA para el polígono.", " The area OCHA gives for the polygon.")) +
					(typeof a.note === "string" ? ` ${a.note}` : ""),
				...(e.type === "country" ? { computed: true } : {}),
			});
		// Capitals come from GeoNames (the seat of each state: PPLC and PPLA), not from the boundaries.
		if (typeof a.capital === "string" && a.capital)
			out.push({
				key: "capital",
				label: tr(l, "Capital", "Capital"),
				value: a.capital,
				source: "GeoNames",
				note: tr(
					l,
					"Capital según GeoNames (sede de la entidad federal: PPLC y PPLA), CC BY 4.0.",
					"Capital according to GeoNames (the federal entity's seat: PPLC and PPLA), CC BY 4.0.",
				),
			});
		else {
			const word: Record<string, { es: string; en: string }> = {
				// The country's 25: 23 states, the Capital District and the Federal Dependencies.
				state: { es: "Entidades federales", en: "Federal entities" },
				municipality: { es: "Municipios", en: "Municipalities" },
				parish: { es: "Parroquias", en: "Parishes" },
			};
			// The places inside it (not the facilities placed directly under it).
			const [type, total] =
				Object.entries(v.children.byType)
					.filter(([t]) => t in word)
					.sort((x, y) => y[1] - x[1])[0] ?? [];
			if (type && total && word[type])
				out.push({
					key: "children",
					label: word[type]?.[l] ?? type,
					value: int(total, l),
					source: tr(l, "límites COD-AB", "COD-AB boundaries"),
					note: `${dataset.name}. ${ds}.`,
					jump: `esec-children-${type}`,
				});
		}
	}
	if (e.type === "infrastructure") {
		const cap = n(a.capacityMW);
		if (cap !== null)
			out.push({
				key: "capacity",
				label: tr(l, "Capacidad declarada", "Stated capacity"),
				value: int(cap, l),
				unit: "MW",
				source: "OpenStreetMap",
				note: `${tr(l, "Capacidad que declara la etiqueta de OpenStreetMap, no la generación actual.", "Capacity as tagged in OpenStreetMap, not current output.")} ${ds}.`,
			});
		const op = e.related.find((r) => r.rel === "operator");
		if (op)
			out.push({
				key: "operator",
				label: tr(l, "Operador", "Operator"),
				value: op.entity.short ?? op.entity.name[l],
				source: tr(l, "registro de Vigía", "Vigía's registry"),
				note: `${op.entity.name[l]}. ${tr(l, "Relación del registro de entidades de Vigía.", "A relation in Vigía's entity registry.")}`,
				entity: op.entity.id,
			});
		else if (typeof a.operatorTag === "string")
			out.push({
				key: "operator",
				label: tr(l, "Operador", "Operator"),
				value: a.operatorTag,
				source: "OpenStreetMap",
				note: `${tr(l, "Etiqueta de operador en OpenStreetMap.", "Operator tag in OpenStreetMap.")} ${ds}.`,
			});
		if (typeof a.source === "string")
			out.push({
				key: "energy",
				label: tr(l, "Fuente de energía", "Energy source"),
				value: a.source
					.split(";")
					.map((x) => INFRA_SOURCE[x.trim()]?.[l] ?? x.trim())
					.join(", "),
				source: "OpenStreetMap",
				note: ds,
			});
		const code = e.codes.iata ?? e.codes.icao;
		if (code)
			out.push({
				key: "code",
				label: e.codes.iata ? "IATA" : "OACI/ICAO",
				value: code,
				source: "OurAirports",
				note: ds,
			});
		if (typeof a.servedCity === "string")
			out.push({
				key: "city",
				label: tr(l, "Ciudad", "City"),
				value: a.servedCity,
				source: "OurAirports",
				note: ds,
			});
	}
	if (e.type === "network") {
		if (Array.isArray(a.asns) && a.asns.length)
			out.push({
				key: "asns",
				label: tr(l, "Sistemas autónomos", "Autonomous systems"),
				value: a.asns.map((x) => `AS${String(x)}`).join(", "),
				source: "RIPE",
				note: ds,
			});
		if (typeof a.service === "string")
			out.push({
				key: "service",
				label: tr(l, "Servicio", "Service"),
				value:
					({ fijo: tr(l, "fijo", "fixed"), movil: tr(l, "móvil", "mobile") } as Record<string, string>)[
						a.service
					] ?? a.service,
				source: tr(l, "registro de Vigía", "Vigía's registry"),
				note: ds,
			});
		if (typeof a.holder === "string")
			out.push({
				key: "holder",
				label: tr(l, "Titular", "Holder"),
				value: a.holder,
				source: "RIPE",
				note: ds,
			});
	}
	if (e.type === "institution" || e.type === "outlet") {
		const att = e.related.find((r) => r.rel === "attached-to");
		if (att)
			out.push({
				key: "attached",
				label: tr(l, "Adscrito a", "Attached to"),
				value: att.entity.short ?? att.entity.name[l],
				source: tr(l, "registro de Vigía", "Vigía's registry"),
				note: att.entity.name[l],
				entity: att.entity.id,
			});
		if (typeof a.region === "string")
			out.push({
				key: "reach",
				label: tr(l, "Alcance", "Reach"),
				value: a.region === "national" ? tr(l, "nacional", "national") : a.region,
				source: tr(l, "registro de Vigía", "Vigía's registry"),
				note: ds,
			});
		if (typeof a.homepage === "string" && /^https?:\/\//.test(a.homepage))
			out.push({
				key: "homepage",
				label: tr(l, "Sitio web", "Website"),
				value: a.homepage.replace(/^https?:\/\//, "").replace(/\/$/, ""),
				source: tr(l, "registro de Vigía", "Vigía's registry"),
				note: ds,
				url: a.homepage,
			});
		if (Array.isArray(a.publishes) && a.publishes.length)
			out.push({
				key: "publishes",
				label: tr(l, "Series que publica", "Series it publishes"),
				value: int(a.publishes.length, l),
				source: tr(l, "fuentes de Vigía", "Vigía's sources"),
				note: tr(
					l,
					"Fuentes de Vigía que leen sus publicaciones.",
					"Vigía sources that read its publications.",
				),
			});
		if (Array.isArray(a.feeds) && a.feeds.length)
			out.push({
				key: "feeds",
				label: tr(l, "Feeds que lee Vigía", "Feeds Vigía reads"),
				value: int(a.feeds.length, l),
				source: tr(l, "fuentes de Vigía", "Vigía's sources"),
				note: tr(
					l,
					"Sitio, YouTube, Telegram…: cada uno con su estado abajo.",
					"Site, YouTube, Telegram…: each with its state below.",
				),
			});
	}
	// Live summaries: open incidents and unusual readings, where the ontology links them to this entity or its state.
	// Not on the country (incidents and readings are scoped to states, so its own list would read "0" beside a room
	// full of them) nor on networks (their only ancestor is the country).
	const live: KeyFact[] = [];
	const scoped = place ? e.type !== "country" : e.type === "infrastructure" || e.type === "institution";
	const incidentsHere = e.type !== "institution";
	const ownerOf = (id: string | undefined | null) => (id && id !== e.id ? id : null);
	const ancestorName = (id: string) => v.parents.find((x) => x.id === id);
	if (scoped && incidentsHere) {
		// An incident as the incidents panel counts one: corroborated (not a watch), measured (not press alone), open.
		const open = v.incidents.filter((i) => i.status === "active" && i.tier === "incident" && !i.reportsOnly);
		const ended = v.incidents.filter((i) => i.status === "ended" && i.tier === "incident").length;
		const inherited = open.filter((i) => ownerOf(i.scope?.id));
		const whose = inherited[0]?.scope ? ancestorName(inherited[0].scope.id) : undefined;
		live.push({
			key: "incidents",
			label: tr(l, "Incidentes abiertos", "Open incidents"),
			value: int(open.length, l),
			source:
				(inherited.length && whose ? ofScope(whose, l) : tr(l, "fuentes que coinciden", "agreeing sources")) +
				(ended
					? tr(l, ` · ${int(ended, l)} terminado${ended === 1 ? "" : "s"}`, ` · ${int(ended, l)} ended`)
					: ""),
			note: tr(
				l,
				"Un incidente es una coincidencia de familias de fuentes independientes, medidas, en un lugar y un rato; calculado por Vigía. No cuenta señales solas ni solo prensa. Los de su estado cuentan aquí y lo dicen.",
				"An incident is independent, measured source families agreeing about one place and time; computed by Vigía. Lone signals and press alone do not count. Its state's count here and say so.",
			),
			computed: true,
			live: "incidents",
			...(v.incidents.length ? { jump: "esec-incidents" } : {}),
		});
	}
	if (scoped || (v.anomalies ?? []).length) {
		const all = v.anomalies ?? [];
		// A move the series already took back is not "unusual now": said apart.
		const current = all.filter((x) => !x.reverted);
		const back = all.length - current.length;
		const inherited = current.filter((x) => ownerOf(x.entity.id));
		const whose = inherited[0] ? ancestorName(inherited[0].entity.id) : undefined;
		live.push({
			key: "unusual",
			label: tr(l, "Lecturas inusuales", "Unusual readings"),
			value: int(current.length, l),
			source:
				(inherited.length && whose ? ofScope(whose, l) : tr(l, "reglas fijas", "fixed rules")) +
				(back ? tr(l, ` · ${int(back, l)} ya volvió`, ` · ${int(back, l)} reverted`) : ""),
			note: tr(
				l,
				"Lecturas raras frente a su propia historia (la suya o la de su estado), calculadas por Vigía: dicen que una cifra se sale de lo habitual, no por qué ni si es grave. Una serie sin datos al día no se juzga.",
				"Readings rare against their own history (its own or its state's), computed by Vigía: they say a figure breaks from the usual, not why or whether it is serious. A series without current data is not judged.",
			),
			computed: true,
			live: "unusual",
			...(typeof v.anomaliesJudged === "number" ? { judged: v.anomaliesJudged } : {}),
			...(all.length ? { jump: "esec-unusual" } : {}),
		});
	}
	return [...out.slice(0, 6 - live.length), ...live];
}
