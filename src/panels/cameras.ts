import { publicCams } from "../adapters/public-cams/index.ts";
import {
	WINDY_ATTRIBUTION,
	WINDY_LICENCE,
	type WindyCam,
	windyWebcams,
} from "../adapters/windy-webcams/index.ts";
import { CAMERAS, WINDY_DUPLICATES } from "../cameras/list.ts";
import { CAMERA_RULES, cameraRulesText } from "../cameras/rules.ts";
import {
	type CameraState,
	type CameraStill,
	cameraState,
	type NightReading,
	nightReading,
} from "../cameras/state.ts";
import type { CameraKind, CameraSpec } from "../cameras/types.ts";
import type { Store, StoredObservation } from "../core/store.ts";
import { placeAt } from "../ontology/geo.ts";
import { registry } from "../ontology/registry.ts";
import type { Panel } from "../server/panels.ts";
import { hhmmVet } from "./cardimage.ts";

/**
 * "Cámaras públicas": every camera of the census with its state (en vivo, caída, congelada…), its newest still
 * (only while it is current: never an old still shown as now), where it is and which way it looks, how to play it,
 * and at night how bright its city lights are against its own past nights. Pure over the archive, at any `now`:
 * the time machine asks the same function at a past moment (src/server/v1/stills.ts).
 */

export type CameraPlay =
	| { type: "hls"; url: string }
	| { type: "youtube"; channelId: string; videoId: string }
	| { type: "embed"; url: string }
	| { type: "link"; url: string };

export type CameraImage = {
	/** Same-origin URL. */
	url: string;
	width: number;
	height: number;
	/** When Vigía took it (epoch ms). */
	takenAt: number;
	/** "Imagen de las 14:05" (Venezuelan time); the UI adds "hace N min" from takenAt. */
	labelEs: string;
	labelEn: string;
};

export type CameraCard = {
	id: string;
	/** Ontology entity (/api/v1/entities/cam.<id>); null for a camera listed by Windy (not in the registry). */
	entity: string | null;
	/** Where the card comes from: Vigía's census, or Windy's list (with the user's key). */
	origin: "census" | "windy";
	name: { es: string; en: string };
	kind: CameraKind;
	operator: { name: string; url: string };
	/** The camera at its operator (open in a new tab). */
	page: string;
	lat: number;
	lon: number;
	headingDeg: number | null;
	country: string;
	/** ISO 3166-2 state and the municipality's entity id, when in Venezuela. */
	state: string | null;
	municipality: string | null;
	view: { es: string; en: string };
	/** What the play button does, only after a press (the operator's own player or stream). */
	play: CameraPlay;
	status: CameraState;
	statusEs: string;
	statusEn: string;
	/** Since when the state holds (a "caída" since its first failed round). */
	since: number | null;
	detail: string | null;
	/** The newest still while the camera is live; null otherwise (then `last` says when the last one was). */
	image: CameraImage | null;
	last: CameraImage | null;
	cadenceMs: number;
	night: NightReading & { statusEs: string };
	terms: { url: string; note: string };
	verified: string;
	/** Credit line for the picture (Windy's own line and link for its cameras). */
	creditEs: string;
	creditUrl: string | null;
};

export type CamerasView = {
	cameras: CameraCard[];
	counts: Record<CameraState, number>;
	/** Cameras whose city lights are dark now (the "cámaras públicas" evidence). */
	dark: string[];
	rules: { es: string[]; en: string[] };
	limits: { es: string; en: string };
	source: { id: string; licence: string; attribution: string };
};

const STATE_TEXT: Record<CameraState, { es: string; en: string }> = {
	live: { es: "En vivo", en: "Live" },
	frozen: { es: "Imagen congelada", en: "Frozen picture" },
	down: { es: "Cámara caída", en: "Camera down" },
	stale: { es: "Sin revisar", en: "Not checked" },
	"no-stills": { es: "Solo en el sitio del operador", en: "Only on the operator's site" },
	locked: { es: "Necesita clave de Windy", en: "Needs a Windy key" },
	unmeasured: { es: "Aún sin revisar", en: "Not checked yet" },
};

const NIGHT_TEXT: Record<NightReading["status"], string> = {
	day: "de día",
	"no-region": "sin zona de luces",
	"no-baseline": "sin línea base aún",
	normal: "luces normales",
	dark: "luces por debajo de la mitad de lo habitual a esta hora",
	unknown: "sin imagen utilizable",
};

function playOf(spec: CameraSpec): CameraPlay {
	const a = spec.access;
	if (a.type === "hls") return { type: "hls", url: a.url };
	if (a.type === "youtube") return { type: "youtube", channelId: a.channelId, videoId: a.videoId };
	if (a.type === "embed") return { type: "embed", url: a.url };
	return { type: "link", url: spec.page };
}

/** A still as a picture, dated by when Vigía first saw these exact bytes (a repeat keeps its first time). */
function imageOf(o: StoredObservation<CameraStill>, firstSeenAt: number | null): CameraImage | null {
	const v = o.value;
	if (!v.blob || !v.width || !v.height) return null;
	const at = Math.min(firstSeenAt ?? o.observedAt, o.observedAt);
	const t = hhmmVet(at);
	return {
		url: `/api/blobs/public-cams/${v.blob}`,
		width: v.width,
		height: v.height,
		takenAt: at,
		labelEs: `Imagen de las ${t}`,
		labelEn: `Still at ${t} (Venezuela)`,
	};
}

/** Where a camera is in the ontology (computed once per camera). */
const places = new Map<string, { state: string | null; municipality: string | null }>();
function placeOf(spec: CameraSpec): { state: string | null; municipality: string | null } {
	const known = places.get(spec.id);
	if (known) return known;
	const p = spec.country === "VE" ? placeAt(spec.lat, spec.lon, 2) : null;
	const muni = p?.municipality ? (registry().byCode(`pcode:${p.municipality}`)?.id ?? null) : null;
	const out = { state: p?.state ?? null, municipality: muni };
	places.set(spec.id, out);
	return out;
}

/** Pure over the store: one camera's card at `now`. */
export function cameraCard(store: Store, spec: CameraSpec, now: number): CameraCard {
	// Newest first under the cap (so a long history never drops the latest stills), then oldest first.
	const history = store
		.recent<CameraStill>(publicCams.id, `cam:${spec.id}`, now - CAMERA_RULES.historyMs, now, 10_000)
		.reverse();
	const s = cameraState(spec, history, now);
	const night = nightReading(spec, history, now, s.state);
	const place = placeOf(spec);
	return {
		id: spec.id,
		entity: `cam.${spec.id}`,
		origin: "census",
		name: spec.name,
		kind: spec.kind,
		operator: spec.operator,
		page: spec.page,
		lat: spec.lat,
		lon: spec.lon,
		headingDeg: spec.headingDeg,
		country: spec.country,
		state: place.state,
		municipality: place.municipality,
		view: spec.view,
		play: playOf(spec),
		status: s.state,
		statusEs: STATE_TEXT[s.state].es,
		statusEn: STATE_TEXT[s.state].en,
		since: s.since,
		detail: s.detail,
		image: s.state === "live" && s.lastStill ? imageOf(s.lastStill, s.firstSeenAt) : null,
		last: s.lastStill ? imageOf(s.lastStill, s.firstSeenAt) : null,
		cadenceMs: spec.stillEveryMs,
		night: { ...night, statusEs: NIGHT_TEXT[night.status] },
		terms: { url: spec.terms.url, note: spec.terms.note },
		verified: spec.verified,
		// "tomada por Vigía" only for a camera whose terms let Vigía keep stills (it takes them); one seen only in its
		// operator's player says whose the picture is.
		creditEs:
			spec.access.type !== "embed" && spec.terms.stills
				? `Imagen: ${spec.operator.name}; imagen fija tomada por Vigía`
				: `Imagen: ${spec.operator.name} (Vigía no guarda imágenes de esta cámara)`,
		creditUrl: spec.operator.url,
	};
}

/** Windy says a camera's picture changed within this long: live (by Windy's word, shown as such). */
export const WINDY_LIVE_MS = 3 * 60 * 60_000;

/** Pure: a Windy-listed camera as a card (no still: Windy's terms), state by Windy's own status and update time. */
export function windyCard(o: StoredObservation<WindyCam>, now: number): CameraCard {
	const w = o.value;
	const fresh = w.lastUpdatedAt !== null && now - w.lastUpdatedAt <= WINDY_LIVE_MS;
	const status: CameraState = w.status === "active" && fresh ? "live" : "down";
	const place = w.country === "VE" ? placeAt(w.lat, w.lon, 2) : null;
	const muni = place?.municipality ? (registry().byCode(`pcode:${place.municipality}`)?.id ?? null) : null;
	return {
		id: `windy-${w.id}`,
		entity: null,
		origin: "windy",
		name: { es: w.title, en: w.title },
		kind: "other",
		operator: { name: "Registrada en Windy por su dueño", url: w.page },
		page: w.page,
		lat: w.lat,
		lon: w.lon,
		headingDeg: null,
		country: w.country ?? "",
		state: place?.state ?? null,
		municipality: muni,
		view: { es: w.title, en: w.title },
		play: { type: "embed", url: w.player },
		status,
		statusEs:
			status === "live"
				? "Imagen renovada en las últimas 3 h, según Windy"
				: `Sin imagen renovada en 3 h, según Windy (${w.status})`,
		statusEn:
			status === "live"
				? "Picture renewed in the last 3 h, according to Windy"
				: `No picture renewed in 3 h, according to Windy (${w.status})`,
		since: null,
		detail: status === "live" ? null : `windy:${w.status}`,
		image: null,
		last: null,
		cadenceMs: 0,
		night: {
			status: "no-region",
			current: null,
			baseline: null,
			ratio: null,
			nights: 0,
			darkSince: null,
			darkLast: null,
			darkStills: 0,
			refs: [],
			statusEs: NIGHT_TEXT["no-region"],
		},
		terms: { url: WINDY_LICENCE.url, note: "Solo el reproductor de Windy; Vigía no guarda sus imágenes." },
		verified: w.lastUpdatedAt ? `Windy: imagen renovada ${new Date(w.lastUpdatedAt).toISOString()}` : "Windy",
		creditEs: WINDY_ATTRIBUTION.text,
		creditUrl: WINDY_ATTRIBUTION.url,
	};
}

export function camerasView(store: Store, now: number, list: readonly CameraSpec[] = CAMERAS): CamerasView {
	const windy = store
		.latestPerSeries<WindyCam>(windyWebcams.id, now - 7 * 24 * 60 * 60_000, 500)
		.filter((o) => o.observedAt <= now && !WINDY_DUPLICATES[o.value.id])
		.sort((a, b) => a.value.id.localeCompare(b.value.id))
		.map((o) => windyCard(o, now));
	const cameras = [...list.map((spec) => cameraCard(store, spec, now)), ...windy];
	const counts = {
		live: 0,
		frozen: 0,
		down: 0,
		stale: 0,
		"no-stills": 0,
		locked: 0,
		unmeasured: 0,
	} satisfies Record<CameraState, number>;
	for (const c of cameras) counts[c.status]++;
	return {
		cameras,
		counts,
		dark: cameras.filter((c) => c.night.status === "dark").map((c) => c.id),
		rules: cameraRulesText(),
		limits: {
			es: "Una cámara muestra un punto y una dirección, no una ciudad: su oscuridad es un indicio que se suma a otras fuentes, nunca una prueba por sí sola. La niebla, la lluvia o un cambio de exposición también oscurecen una imagen.",
			en: "A camera shows one spot and one direction, not a city: its darkness is a hint that adds to other sources, never proof on its own. Fog, rain or an exposure change also darken a picture.",
		},
		source: {
			id: publicCams.id,
			licence: publicCams.licence.name,
			attribution: publicCams.licence.attribution,
		},
	};
}

export const camerasPanel: Panel<CamerasView> = {
	id: "cameras",
	sources: [publicCams.id, windyWebcams.id],
	onDemand: true,
	compute: (store, now) => camerasView(store, now),
};
