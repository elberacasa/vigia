/**
 * The entity API's view models (/api/v1/entities…, /api/v1/locate): what the server computes and the client renders.
 * Types only, with no imports, so the web client can `import type` from here without pulling server code into its
 * bundle. The response schemas in src/server/v1/schemas.ts describe the same shapes for the OpenAPI document, and
 * a type-level test (entities.test.ts) keeps the two identical.
 *
 * Times are Unix milliseconds (UTC). Every figure carries its feed, link, observed and fetched time and a stale
 * flag; figures Vigía computes (counts, sums, comparisons with a baseline) say `computed: true` and are labelled
 * "calculado por Vigía" with their method.
 */

export type EntityTypeView =
	| "country"
	| "state"
	| "municipality"
	| "parish"
	| "infrastructure"
	| "network"
	| "outlet"
	| "institution"
	| "camera";

export type BilingualView = { es: string; en: string };

export type JsonView = null | boolean | number | string | JsonView[] | { [key: string]: JsonView };

export type BasisView = "measurement" | "official" | "quote" | "report" | "derived";

/** A compact reference to an entity, enough to label and link it. */
export type EntityRef = {
	id: string;
	type: EntityTypeView;
	/** Subtype: infrastructure kind ("power-plant"…), network kind ("isp", "asn"), outlet stance, institution kind. */
	kind: string | null;
	name: BilingualView;
	short: string | null;
	/** The entity's API path. */
	href: string;
};

/** Where the entity data itself comes from (not the signals attached to it). */
export type DatasetRef = {
	id: string;
	name: string;
	url: string;
	licence: { id: string; name: string; url: string };
	attribution: string;
	retrieved: string;
};

export type RelationView = {
	rel: "operator" | "network-of" | "publishes" | "attached-to";
	entity: EntityRef;
};

export type EntityDetail = EntityRef & {
	aliases: string[];
	point: { lat: number; lon: number } | null;
	/** Where its geometry lives ("cod-ab:VE0101", "osm:way/102819548", "grid:infra.red-765kv"); null without one. */
	geometry: string | null;
	codes: Record<string, string>;
	attributes: Record<string, JsonView>;
	related: RelationView[];
	dataset: DatasetRef;
};

/** The source behind one figure. */
export type FigureSource = {
	/** Adapter id; null when the figure sums several feeds (e.g. every outlet). */
	feed: string | null;
	name: string;
	sourceUrl: string | null;
	licence: string;
	attribution: string;
};

/** One live signal about the entity (or about the ancestor it is measured at: see `scope`). */
export type NowItem = {
	/** Which signal: "connectivity", "probes", "nightlights", "fires", "weather", "quakes", "news", "flares", "port-calls", "reservoir", "censorship", "routing", "feed", "figure", "lightning", "gdelt", "broadcast", "office", "sanctions", "markets". */
	layer: string;
	/**
	 * The entity the figure is about: this entity, or an ancestor when the source measures at a coarser level
	 * (IODA and night lights are per state, so a municipality shows its state's figure, labelled).
	 */
	scope: EntityRef;
	label: BilingualView;
	/** One line with the figure, in words. */
	text: BilingualView;
	/** The figures themselves, units in the names (`pctOfBaseline`, `frpMW`). */
	figures: Record<string, number | string | boolean | null>;
	source: FigureSource;
	observedAt: number | null;
	fetchedAt: number | null;
	/** The feed missed its freshness budget, or this datum is older than the feed's data budget. */
	stale: boolean;
	basis: BasisView;
	/** Computed by Vigía (a count, a sum, a comparison with a baseline): shown as "calculado por Vigía". */
	computed: boolean;
	/** How it was computed, when `computed`. */
	method: string | null;
};

/** People living in an area, from two sources shown side by side, never blended. */
export type PopulationView = {
	census2011: { people: number; source: string; licence: string; note: string } | null;
	worldpop2026: { people: number; source: string; licence: string; note: string } | null;
	/** Summed by Vigía from municipal or parish figures, or from grid cells. */
	computed: boolean;
	method: string;
};

/**
 * "Personas que viven en el área" of an incident: a modelled estimate, labelled as such, never a count of people
 * affected, without service, or who felt anything. Only for incidents of at least two independent source families
 * (users' reports join but never count; never a lone signal, never the press alone): null otherwise.
 */
export type PopulationInAreaView = {
	/** What area was counted, in words ("personas que viven en Zulia", "a menos de 25 km del epicentro, en Venezuela"). */
	area: BilingualView;
	people: number;
	/** For a quake: the same count at each stated radius. */
	radii: { km: number; people: number }[] | null;
	/** Always an estimate (WorldPop's model), never a measurement or a count. */
	basis: "estimate";
	source: string;
	licence: string;
	note: string;
	computed: true;
	method: string;
	caveat: BilingualView;
};

export type IncidentBrief = {
	id: string;
	kind: string;
	title: BilingualView;
	status: "active" | "ended";
	tier: "incident" | "watch";
	/** Independent source families that agree: the only strength Vigía states. */
	corroboration: number;
	families: string[];
	reportsOnly: boolean;
	startAt: number;
	lastEvidenceAt: number;
	/** The entity the incident is about (a state for an outage), which may be an ancestor of this one. */
	scope: EntityRef | null;
	populationInArea: PopulationInAreaView | null;
	href: string;
};

export type StoryBrief = {
	title: string;
	url: string;
	at: number;
	fetchedAt: number;
	outlet: EntityRef | null;
	outletName: string;
	/** The news panel's story this headline belongs to, when it is in the panel's 48-hour window. */
	storyId: string | null;
	/** Distinct outlets carrying the story (1 when it is not in the panel). */
	outlets: number;
	/** How the headline was linked: "text-place" is keyword location ("ubicación por palabra clave"). */
	rule: string;
	confidence: number;
};

export type NearbyItem = {
	entity: EntityRef;
	/** Distance from this entity's point, km; 0 for facilities inside a place. */
	km: number;
	/** Inside this place (a descendant), or near it (within the stated radius). */
	relation: "inside" | "near";
};

export type EntityView = {
	entity: EntityDetail;
	/** Ancestors, nearest first. */
	parents: EntityRef[];
	children: { total: number; byType: Record<string, number>; items: EntityRef[]; truncated: boolean };
	now: NowItem[];
	incidents: IncidentBrief[];
	stories: StoryBrief[];
	/**
	 * Facilities inside a place, or near a facility. `order` says how `items` are listed: "distance" (nearest to this
	 * entity's point first; the same distance, to 0.1 km, by kind: plants, refineries… hospitals, lines last) or
	 * "kind" (the entity has no point of its own).
	 */
	nearby: {
		rule: BilingualView;
		order: "distance" | "kind";
		byKind: Record<string, number>;
		items: NearbyItem[];
		truncated: boolean;
	};
	population: PopulationView | null;
	/**
	 * "Lo inusual ahora" about this entity, or about an ancestor its figures are measured at (a municipality shows
	 * its state's connectivity anomaly): the anomaly engine's items, highest score first.
	 */
	anomalies: AnomalyItem[];
	/**
	 * How many series about this entity (or its state) the anomaly engine judged now: fresh, with enough history.
	 * 0 means "sin datos para juzgar", never "nothing unusual" (whole-release review, M10).
	 */
	anomaliesJudged: number;
	links: {
		timeline: string;
		rules: { es: string[]; en: string[] };
		/** Archived observations not linked yet (the link index catching up after a restart). */
		backlog: number;
	};
	asOf: number;
};

/**
 * One unusual reading ("lo inusual ahora"): the newest point of one series (source × entity × metric) against a
 * baseline suited to the series' rhythm, computed by Vigía by a stated rule (never a model). An anomaly says a
 * figure is rare against its own history, never why or that it is serious.
 */
export type AnomalyItem = {
	/** Stable for the same reading: metric, entity and the newest point's time. */
	id: string;
	/** One line that names it ("Caída simultánea de conectividad: Táchira (−62,6 %) y Amazonas (−57,1 %)"). */
	title: BilingualView;
	/** The entity it is about; the country for a regional item (see `members`). */
	entity: EntityRef;
	metric: {
		/** "connectivity", "nightlights", "bcv.usd", "bcv.reserves", "yadio.usd", "tor.bridge", "wiki.…", "fires", "gdelt", "headlines", "lightning"… */
		id: string;
		label: BilingualView;
		unit: BilingualView | null;
		/** The rhythm the baseline follows: "connectivity", "night", "change", "level", "count", "hourly". */
		class: string;
	};
	direction: "up" | "down";
	/**
	 * The newest value and the value the baseline expects, in the metric's unit; null for sources whose terms forbid
	 * passing their data on (IODA): only the change and the score are published for those.
	 */
	value: number | null;
	baseline: number | null;
	/** (value − baseline) / baseline × 100. */
	changePct: number | null;
	/** Robust z: how many robust standard deviations from the baseline (signed); the list is ranked by its size. */
	score: number;
	/** Counts only: Poisson P(X ≥ value) with the baseline as mean. */
	tail: number | null;
	/** The baseline's window: in words, how many points it used, and its bounds (Unix ms). */
	window: { text: BilingualView; points: number; from: number | null; to: number | null };
	/** This reading's rule in words, with its numbers. */
	rule: BilingualView;
	source: FigureSource;
	observedAt: number;
	fetchedAt: number | null;
	/** now − observedAt when computed, ms (a reading older than its series' budget is never an anomaly). */
	ageMs: number;
	/** An open (or just ended) incident in the same place that already explains it; null otherwise. */
	explainedBy: { id: string; title: BilingualView; tier: "incident" | "watch"; href: string } | null;
	/** Figures behind the reading (the IODA signals as % of baseline, Tor's expected range…). */
	figures: Record<string, number | string | boolean | null>;
	/**
	 * A regional item: states whose drops began together, each with its own figure (never a blended one); the
	 * per-state readings are in `AnomaliesView.grouped` and on each state's page. Null for any other item.
	 */
	members: AnomalyMember[] | null;
	/** On a per-state reading folded into a regional item: that item's id. Null otherwise. */
	groupId: string | null;
	/**
	 * The published series took this move back: the level returned near where it stood before, `afterSteps`
	 * published points later. A fact about the series, not a guess about why; the item ranks after the others.
	 */
	reverted: {
		afterSteps: number;
		at: number;
		date: string;
		value: number | null;
		text: BilingualView;
	} | null;
	computed: true;
	method: string;
	basis: "derived";
};

export type AnomalyMember = {
	entity: EntityRef;
	/** Its own change against its own baseline, and its own score. */
	changePct: number | null;
	score: number;
	/** When its drop began (the first bin of the run below the drop threshold). */
	onsetAt: number;
	observedAt: number;
	explainedBy: AnomalyItem["explainedBy"];
};

export type AnomaliesView = {
	asOf: number;
	/** The engine's rules version. */
	version: number;
	/** Highest |score| first. */
	items: AnomalyItem[];
	/** More items than the list keeps. */
	truncated: boolean;
	/** Per-state readings folded into a regional item of `items` (each with its `groupId`). */
	grouped: AnomalyItem[];
	/**
	 * Series looked at, judged (fresh and with enough history), unusual, explained by an incident, and why the others
	 * were not judged: thin history, no recent data, too weak (or not comparable) to judge.
	 */
	counts: {
		series: number;
		judged: number;
		unusual: number;
		explained: number;
		/** Regional items, and the per-state readings folded into them. */
		regions: number;
		grouped: number;
		/** Items about a move the series took back. */
		reverted: number;
		thin: number;
		stale: number;
		weak: number;
		byClass: Record<string, { series: number; judged: number; unusual: number }>;
		/** Series judged per entity id (fresh, with enough history): what an entity page's count may stand on. */
		judgedByEntity: Record<string, number>;
	};
	rules: { es: string[]; en: string[] };
};

export type TimelineItem = {
	at: number;
	/**
	 * "quake", "fire", "flare", "outage", "hazard", "headline", "gazette", "routing", "incident", "sanction",
	 * "licence", "intervention"; and, only when asked for with `kinds`, "gdelt", "lightning", "broadcast", "office",
	 * "market".
	 */
	kind: string;
	title: BilingualView;
	source: FigureSource;
	url: string;
	observedAt: number;
	fetchedAt: number;
	/** How it is linked to the entity, and how sure: see `rules`. */
	rule: string;
	confidence: number;
	/** For "near" links: distance to the facility, km. */
	km: number | null;
	/** Figures from sources whose terms allow passing them on; null otherwise (only the summary is shown). */
	figures: Record<string, number | string | boolean | null> | null;
};

export type TimelineView = {
	entity: EntityRef;
	from: number;
	to: number;
	items: TimelineItem[];
	truncated: boolean;
	rules: { es: string[]; en: string[] };
	backlog: number;
};

export type SearchView = {
	query: string;
	type: EntityTypeView | null;
	/** More entities matched (or are of the type) than `limit`. */
	truncated: boolean;
	results: { entity: EntityRef; parent: EntityRef | null; score: number; matched: string }[];
};

export type LocateView = {
	lat: number;
	lon: number;
	/** Parish, municipality and state containing the point, nearest first; empty outside Venezuela. */
	places: EntityRef[];
	/** On Lake Maracaibo, or snapped to nothing: how the point was placed. */
	how: "inside" | "lake" | "outside";
	/** Facilities within `radiusKm`, nearest first. */
	near: NearbyItem[];
	radiusKm: number;
};
