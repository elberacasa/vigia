import { expect, test } from "bun:test";
import {
	type AnomaliesView,
	type AnomalyItem,
	changeLine,
	countsLine,
	explainedText,
	listLine,
	memberLine,
	scoreText,
	sourceUrl,
	whenLine,
} from "./anomaly-view.ts";
import {
	type CameraCard,
	currentStill,
	lastStill,
	nightLine,
	playTarget,
	statusLine,
	tvPicture,
} from "./cameras.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 8, 29, 6, 0);

const ref = (id: string, es: string) => ({
	id,
	type: "state" as const,
	kind: null,
	name: { es, en: es },
	short: null,
	href: `/api/v1/entities/${id}`,
});

/** Shaped like the engine's items (src/ontology/view.ts AnomalyItem). */
function item(o: Partial<AnomalyItem>): AnomalyItem {
	return {
		id: "x",
		title: { es: "t", en: "t" },
		entity: ref("ve.tachira", "Táchira"),
		metric: {
			id: "connectivity",
			label: { es: "Conectividad", en: "Connectivity" },
			unit: null,
			class: "connectivity",
		},
		direction: "down",
		value: null,
		baseline: null,
		changePct: -62.6,
		score: -14.2,
		tail: null,
		window: {
			text: { es: "misma franja, 7 días", en: "same slot, 7 days" },
			points: 7,
			from: null,
			to: null,
		},
		rule: { es: "regla", en: "rule" },
		source: {
			feed: "ioda-states",
			name: "IODA",
			sourceUrl: "https://ioda.inetintel.cc.gatech.edu/",
			licence: "x",
			attribution: "x",
		},
		observedAt: NOW - 20 * MIN,
		fetchedAt: NOW - 19 * MIN,
		ageMs: 20 * MIN,
		explainedBy: null,
		figures: {},
		members: null,
		groupId: null,
		reverted: null,
		computed: true,
		method: "m",
		basis: "derived",
		...o,
	} as AnomalyItem;
}

test("an unusual reading: the change, and the value against the baseline only when the source allows it", () => {
	// IODA: only the change; no value is invented.
	expect(changeLine(item({}), "es")).toBe("−62,6 % frente a lo esperado");
	const bcv = item({
		metric: {
			id: "bcv.usd",
			label: { es: "Dólar BCV", en: "BCV dollar" },
			unit: { es: "Bs.", en: "Bs." },
			class: "change",
		},
		value: 857.89,
		baseline: 842.1,
		changePct: 1.9,
		direction: "up",
	});
	expect(changeLine(bcv, "es")).toBe("+1,9 % frente a lo esperado · 857,9 Bs. (esperado 842,1 Bs.)");
	expect(
		changeLine(
			item({
				changePct: 487.3,
				value: 12_345,
				baseline: 2_100,
				metric: { ...bcv.metric, unit: { es: "lecturas", en: "reads" } },
			}),
			"es",
		),
	).toBe("+487 % frente a lo esperado · 12.345 lecturas (esperado 2.100 lecturas)");
	expect(scoreText(-14.23, "es")).toBe("z = −14,2");
	expect(scoreText(5, "en")).toBe("z = 5.0");
	expect(sourceUrl(item({}))).toBe("https://ioda.inetintel.cc.gatech.edu/");
	expect(sourceUrl(item({ source: { ...item({}).source, sourceUrl: "javascript:alert(1)" } }))).toBeNull();
});

test("when it is from: an age, the value date of a rate published ahead, a gap in the source", () => {
	expect(whenLine(item({}), NOW, "es")).toBe("hace 20 min");
	const ahead = item({ observedAt: Date.UTC(2026, 8, 30, 4), figures: { valueDateAhead: true } });
	expect(whenLine(ahead, NOW, "es")).toBe("tasa del 30 sept, 00:00");
	expect(whenLine(item({ figures: { stepsSpanned: 3 } }), NOW, "es")).toBe(
		"hace 20 min · tras 3 días sin datos",
	);
});

test("regional items list each state with its own figure; what explains an item is said by its tier", () => {
	const m = {
		entity: ref("ve.amazonas", "Amazonas"),
		changePct: -57.1,
		score: -9,
		onsetAt: NOW - 30 * MIN,
		observedAt: NOW,
		explainedBy: null,
	};
	expect(memberLine(m, NOW, "es")).toBe("−57,1 % · desde las 01:30");
	expect(memberLine({ ...m, changePct: null }, NOW, "es")).toBe("sin cifra publicable · desde las 01:30");
	const e = {
		id: "i",
		title: { es: "Posible apagón en Zulia", en: "Possible blackout in Zulia" },
		href: "/api/v1/incidents/i",
	};
	expect(explainedText({ ...e, tier: "incident" }, "es")).toBe("ya es un incidente: Posible apagón en Zulia");
	expect(explainedText({ ...e, tier: "watch" }, "es")).toBe("señal sin corroborar: Posible apagón en Zulia");
});

test("the list's lines never say 'todo normal': how many series were judged and why not the others", () => {
	const counts = {
		series: 235,
		judged: 61,
		unusual: 0,
		explained: 0,
		regions: 0,
		grouped: 0,
		reverted: 0,
		thin: 145,
		stale: 27,
		weak: 2,
		byClass: {},
		judgedByEntity: {},
	};
	const view = {
		asOf: NOW,
		version: 2,
		items: [],
		truncated: false,
		grouped: [],
		counts,
		rules: { es: [], en: [] },
	} as AnomaliesView;
	expect(listLine(view, "es")).toBe(
		"Ninguna lectura inusual entre las 61 series que se pueden juzgar ahora.",
	);
	expect(countsLine(counts, "es")).toBe(
		"235 series; 61 juzgadas; 145 con poca historia; 27 sin datos recientes; 2 sin comparación posible",
	);
	const two = {
		...view,
		items: [
			item({}),
			item({ id: "y", explainedBy: { id: "i", title: { es: "a", en: "a" }, tier: "incident", href: "" } }),
		],
	};
	expect(listLine(two, "es")).toBe(
		"2 lecturas inusuales frente a su propia historia; 1 ya la explica un incidente.",
	);
});

const cam = (o: Partial<CameraCard>): CameraCard =>
	({
		id: "c",
		entity: "cam.c",
		status: "live",
		statusEs: "En vivo",
		statusEn: "Live",
		since: null,
		cadenceMs: 20 * MIN,
		image: {
			url: "/api/blobs/public-cams/a",
			width: 480,
			height: 360,
			takenAt: NOW - 10 * MIN,
			labelEs: "Imagen de las 01:50",
			labelEn: "Still at 01:50",
		},
		last: null,
		night: null,
		play: null,
		...o,
	}) as CameraCard;

test("a camera's picture is current only while live and within twice its interval plus 5 min", () => {
	expect(currentStill(cam({}), NOW)?.url).toBe("/api/blobs/public-cams/a");
	// 46 min old at a 20-min cadence: past 2 × 20 + 5, shown only as the last picture, dimmed.
	const base = cam({}).image;
	if (!base) throw new Error("no image");
	const old = cam({ image: { ...base, takenAt: NOW - 46 * MIN } });
	expect(currentStill(old, NOW)).toBeNull();
	expect(lastStill(old, NOW)?.takenAt).toBe(NOW - 46 * MIN);
	expect(currentStill(cam({ status: "down" }), NOW)).toBeNull();
	expect(statusLine(cam({ statusEs: "Cámara caída", since: NOW - 60 * MIN }), "es")).toBe(
		"Cámara caída desde las 01:00",
	);
	expect(
		nightLine(
			{ status: "dark", current: 0.001, baseline: 0.004, ratio: 0.42, nights: 9, statusEs: "oscura" },
			"es",
		),
	).toBe("Luces: 42 % de su mediana a esta hora, 9 noches (calculado por Vigía)");
	expect(
		nightLine(
			{
				status: "no-baseline",
				current: 0.01,
				baseline: null,
				ratio: null,
				nights: 0,
				statusEs: "sin línea base aún",
			},
			"es",
		),
	).toBe("Brillo nocturno: sin línea base aún");
	// Only Windy's player path is framed (the page CSP allows no other); anything else is a link.
	expect(
		playTarget({
			type: "embed",
			url: "https://webcams.windy.com/webcams/public/embed/player/1409864366/day",
		}),
	).toBe("embed");
	expect(playTarget({ type: "embed", url: "https://evil.example/player" })).toBe("link");
	expect(playTarget({ type: "youtube", videoId: null })).toBeNull();
	expect(playTarget({ type: "youtube", videoId: "28U-t3fA9ks" })).toBe("youtube");
});

test("a TV card never shows a still older than 45 min, a cover is not a frame, and it always has something to show", () => {
	const still = {
		kind: "still" as const,
		url: "/api/blobs/tv-stills/a",
		width: 480,
		height: 270,
		takenAt: NOW - 12 * MIN,
		source: "tv-frame" as const,
		labelEs: "Cuadro de las 01:48",
		labelEn: "Frame at 01:48",
		creditEs: "Imagen: señal de la televisora; cuadro tomado por Vigía",
	};
	expect(tvPicture(still, NOW, 45 * MIN, "es")).toMatchObject({
		kind: "still",
		label: "Cuadro de las 01:48",
		cover: false,
	});
	expect(tvPicture({ ...still, source: "youtube-cover" }, NOW, 45 * MIN, "es")).toMatchObject({
		cover: true,
	});
	// Cached past its budget without a logo (an older server): the name, saying the frame's time.
	expect(tvPicture({ ...still, takenAt: NOW - 50 * MIN }, NOW, 45 * MIN, "es")).toEqual({
		kind: "name",
		label: "Sin cuadro reciente",
		why: "el último cuadro es de las 01:10",
	});
	// With the logo the server sends beside the still: the logo, saying the frame's time.
	const withLogo = {
		...still,
		takenAt: NOW - 50 * MIN,
		logo: { url: "/api/blobs/tv-logos/l", width: 200, height: 144, creditEs: "Logo: iptv-org" },
	};
	expect(tvPicture(withLogo, NOW, 45 * MIN, "es")).toEqual({
		kind: "logo",
		url: "/api/blobs/tv-logos/l",
		width: 200,
		height: 144,
		label: "Sin cuadro reciente",
		why: "el último cuadro es de las 01:10",
		credit: "Logo: iptv-org",
	});
	// A fresh still stays the picture however it carries a logo.
	expect(tvPicture({ ...withLogo, takenAt: NOW - 5 * MIN }, NOW, 45 * MIN, "es").kind).toBe("still");
	const logo = {
		kind: "logo" as const,
		url: "/api/blobs/tv-logos/l",
		width: 200,
		height: 144,
		labelEs: "Sin cuadro reciente",
		labelEn: "No recent frame",
		whyEs: "la señal no respondió (http-404)",
		whyEn: "the stream did not answer (http-404)",
		creditEs: "Logo: iptv-org",
	};
	expect(tvPicture(logo, NOW, 45 * MIN, "es")).toMatchObject({
		kind: "logo",
		why: "la señal no respondió (http-404)",
	});
	expect(tvPicture(null, NOW, 45 * MIN, "es")).toEqual({
		kind: "name",
		label: "Sin cuadro reciente",
		why: null,
	});
	expect(
		tvPicture(
			{
				kind: "none",
				labelEs: "Sin cuadro reciente",
				labelEn: "No recent frame",
				whyEs: "aún no se ha tomado un cuadro",
				whyEn: "",
			},
			NOW,
			45 * MIN,
			"es",
		),
	).toEqual({ kind: "name", label: "Sin cuadro reciente", why: "aún no se ha tomado un cuadro" });
});
