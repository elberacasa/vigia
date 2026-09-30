import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	measure,
	publicCams,
	resetCameraMemory,
	stillCameras,
	stillOf,
} from "../adapters/public-cams/index.ts";
import { BlobStore } from "../core/blobs.ts";
import { Store, type StoredObservation } from "../core/store.ts";
import type { FetchContext, HttpLike, Observation } from "../core/types.ts";
import { HttpError } from "../core/types.ts";
import { encodeJpeg } from "../imaging/jpeg.ts";
import { decodeImage, downscale, type Rgba } from "../imaging/raster.ts";
import { useResolver } from "../media/public-host.ts";
import { camerasView } from "../panels/cameras.ts";
import { cameraEvidence } from "./evidence.ts";
import { CAMERAS, WINDY_DUPLICATES } from "./list.ts";
import { CAMERA_RULES, cameraRulesText } from "./rules.ts";
import { type CameraStill, cameraState, nightReading, solarTimeOfDay } from "./state.ts";
import type { CameraSpec } from "./types.ts";

/** No DNS in tests: every *.example host is a public address, intranet.example a private one. */
useResolver(async (host) => (host.startsWith("intranet.") ? ["10.0.0.5"] : ["93.184.215.14"]));

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 02:00 in Venezuela (06:00 UTC) on 2026-10-10: deep night at every camera in the census. */
const NIGHT = Date.UTC(2026, 9, 10, 6, 0);

const spec: CameraSpec = {
	id: "prueba",
	name: { es: "Cámara de prueba", en: "Test camera" },
	kind: "skyline",
	operator: { name: "Operador de prueba", url: "https://cam.example/" },
	page: "https://cam.example/",
	lat: 10.5,
	lon: -66.9,
	positionFrom: "prueba",
	headingDeg: 90,
	headingFrom: "prueba",
	view: { es: "vista", en: "view" },
	country: "VE",
	access: { type: "jpeg", url: "https://cam.example/current.jpg" },
	stillEveryMs: 10 * MIN,
	terms: { url: "https://cam.example/", note: "prueba", stills: true },
	lights: { region: { x: 0, y: 0.5, w: 1, h: 0.25 }, what: "luces" },
	verified: "prueba",
};

let nextId = 1;
function still(at: number, over: Partial<CameraStill> = {}): StoredObservation<CameraStill> {
	return {
		id: nextId++,
		source: "public-cams",
		series: `cam:${spec.id}`,
		sourceUrl: spec.page,
		fetchedAt: at,
		observedAt: at,
		licence: "public-cam-reference",
		value: {
			camera: spec.id,
			blob: `c1-${at.toString(36)}-0123456789abcdef`,
			width: 480,
			height: 270,
			reason: null,
			sourceSha: at.toString(16).padStart(16, "0").slice(-16),
			hash: "0f0f0f0f0f0f0f0f",
			lumaMean: 50,
			lumaSd: 10,
			lightsMean: 55,
			lightsBright: 0.003,
			sunDeg: -60,
			night: true,
			sourceTime: null,
			bytes: 500_000,
			ms: 900,
			...over,
		} as CameraStill,
		confidence: 1,
		basis: "measurement",
	} as StoredObservation<CameraStill>;
}
const failed = (at: number, reason = "http-503") =>
	still(at, {
		blob: null,
		width: null,
		height: null,
		reason,
		sourceSha: null,
		hash: null,
		lightsBright: null,
	});

describe("state: live, down, frozen, stale, no stills — never an old still as now", () => {
	test("a recent still is live; one past two cadences is stale (Vigía did not try)", () => {
		expect(cameraState(spec, [still(NIGHT - 5 * MIN)], NIGHT).state).toBe("live");
		const later = NIGHT + 2 * spec.stillEveryMs + CAMERA_RULES.liveSlackMs;
		expect(cameraState(spec, [still(NIGHT - 5 * MIN)], later).state).toBe("stale");
		expect(cameraState(spec, [], NIGHT).state).toBe("unmeasured");
	});

	test("down: failed rounds spanning 20 min; one failure after a recent still is still live", () => {
		const h = [still(NIGHT - 40 * MIN), failed(NIGHT - 20 * MIN), failed(NIGHT - 10 * MIN), failed(NIGHT)];
		expect(cameraState(spec, h, NIGHT)).toMatchObject({
			state: "down",
			since: NIGHT - 20 * MIN,
			detail: "http-503",
		});
		expect(cameraState(spec, [still(NIGHT - 10 * MIN), failed(NIGHT)], NIGHT).state).toBe("live");
	});

	test("frozen: three byte-identical stills over 30 min; different bytes are live", () => {
		const same = { sourceSha: "aaaaaaaaaaaaaaaa" };
		const h = [
			still(NIGHT - 30 * MIN, same),
			still(NIGHT - 20 * MIN, same),
			still(NIGHT - 10 * MIN, same),
			still(NIGHT, same),
		];
		expect(cameraState(spec, h, NIGHT)).toMatchObject({ state: "frozen", since: NIGHT - 30 * MIN });
		expect(cameraState(spec, h.slice(-2), NIGHT).state).toBe("live");
	});

	test("embed-only and YouTube cameras take no still; only attempts at or before now count", () => {
		expect(
			cameraState({ ...spec, access: { type: "embed", url: "https://x.example" } }, [], NIGHT).state,
		).toBe("no-stills");
		expect(cameraState({ ...spec, terms: { ...spec.terms, stills: false } }, [], NIGHT).state).toBe(
			"no-stills",
		);
		expect(cameraState(spec, [still(NIGHT + 5 * MIN)], NIGHT).state).toBe("unmeasured");
	});
});

/** Six past nights at the same hour with lights at `lit`, then tonight's stills. */
function nights(lit: number, count = 6): StoredObservation<CameraStill>[] {
	return Array.from({ length: count }, (_, i) => still(NIGHT - (count - i) * DAY, { lightsBright: lit }));
}

describe("night brightness: the lights region against the camera's own past nights", () => {
	test("dark: two stills 20 min apart at a tenth of the baseline, with the camera alive", () => {
		const h = [
			...nights(0.003),
			still(NIGHT - 20 * MIN, { lightsBright: 0.0003 }),
			still(NIGHT, { lightsBright: 0 }),
		];
		const r = nightReading(spec, h, NIGHT, cameraState(spec, h, NIGHT).state);
		expect(r).toMatchObject({
			status: "dark",
			baseline: 0.003,
			nights: 6,
			ratio: 0,
			darkSince: NIGHT - 20 * MIN,
			darkStills: 2,
		});
		expect(r.refs).toHaveLength(2);
	});

	test("one dark still, or a dip to 60 % (fog, exposure), is normal", () => {
		const one = [...nights(0.003), still(NIGHT - 20 * MIN), still(NIGHT, { lightsBright: 0 })];
		expect(nightReading(spec, one, NIGHT, "live").status).toBe("normal");
		const fog = [
			...nights(0.003),
			still(NIGHT - 20 * MIN, { lightsBright: 0.0018 }),
			still(NIGHT, { lightsBright: 0.0018 }),
		];
		expect(nightReading(spec, fog, NIGHT, "live")).toMatchObject({ status: "normal", ratio: 0.6 });
	});

	test("no judgement without 5 past nights, with lights too faint, by day, or when frozen", () => {
		const few = [
			...nights(0.003, 4),
			still(NIGHT - 20 * MIN, { lightsBright: 0 }),
			still(NIGHT, { lightsBright: 0 }),
		];
		expect(nightReading(spec, few, NIGHT, "live")).toMatchObject({ status: "no-baseline", nights: 4 });
		const faint = [...nights(0.0001), still(NIGHT, { lightsBright: 0 })];
		expect(nightReading(spec, faint, NIGHT, "live").status).toBe("no-baseline");
		expect(nightReading(spec, [still(NIGHT, { night: false, sunDeg: 30 })], NIGHT, "live").status).toBe(
			"day",
		);
		expect(nightReading(spec, [...nights(0.003), still(NIGHT)], NIGHT, "frozen").status).toBe("unknown");
		expect(nightReading({ ...spec, lights: null }, [still(NIGHT)], NIGHT, "live").status).toBe("no-region");
	});

	test("the baseline is the same solar hour ± 1 h on past nights only: other hours and tonight never count", () => {
		// Past nights at 20:00 local (4 h earlier) are a different hour: no baseline at 02:00.
		const otherHour = Array.from({ length: 6 }, (_, i) => still(NIGHT - (6 - i) * DAY - 6 * HOUR));
		expect(nightReading(spec, [...otherHour, still(NIGHT)], NIGHT, "live").status).toBe("no-baseline");
		expect(solarTimeOfDay(NIGHT, -66.9)).toBeCloseTo((6 - 66.9 / 15) * HOUR, -3);
	});
});

describe("evidence: only Venezuelan cameras, only while fresh, family camaras", () => {
	const card = (over: Record<string, unknown> = {}) => ({
		id: "charallave-oeste",
		name: { es: "Aeropuerto de Charallave: vista oeste", en: "Charallave airport: west view" },
		operator: { name: "Aeropuerto Caracas, C.A." },
		state: "VE-M",
		entity: "cam.charallave-oeste",
		night: {
			status: "dark",
			ratio: 0.1,
			baseline: 0.003,
			current: 0.0003,
			nights: 6,
			darkSince: NIGHT - 20 * MIN,
			darkLast: NIGHT,
			darkStills: 2,
			refs: [{ series: "cam:charallave-oeste", observedAt: NIGHT }],
		},
		...over,
	});
	test("a dark camera in a state is power evidence of the camaras family, labelled as computed", () => {
		const e = cameraEvidence(card(), NIGHT + MIN);
		expect(e).toMatchObject({
			family: "camaras",
			role: "signal",
			speaks: "power",
			at: NIGHT - 20 * MIN,
			lastAt: NIGHT,
		});
		expect(e?.es).toContain("10 %");
		expect(e?.es).toContain("calculado por Vigía");
		expect(e?.url).toBe("/api/v1/entities/cam.charallave-oeste");
	});
	test("abroad, stale, not dark, or a Windy-listed card: none", () => {
		expect(cameraEvidence(card({ state: null }), NIGHT)).toBeNull();
		expect(cameraEvidence(card(), NIGHT + CAMERA_RULES.evidenceFreshMs + 1)).toBeNull();
		expect(cameraEvidence(card({ night: { ...card().night, status: "normal" } }), NIGHT)).toBeNull();
		expect(cameraEvidence(card({ entity: null }), NIGHT)).toBeNull();
	});
});

// ---- the adapter over synthetic pictures (invented scenes, no operator's image) ----

/** A night view: sensor noise around 50, and (when `lit`) a row of small bright lights in the lower half. */
function nightScene(lit: boolean, seed = 1): Rgba {
	const w = 960;
	const h = 540;
	const data = new Uint8Array(w * h * 4);
	let s = seed;
	const rnd = () => {
		s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
		return s / 2_147_483_648;
	};
	for (let i = 0; i < w * h; i++) {
		const v = Math.round(45 + rnd() * 12);
		data.set([v, v, v, 255], i * 4);
	}
	if (lit)
		for (let k = 0; k < 24; k++) {
			const cx = 20 + k * 38;
			const cy = 330 + (k % 3) * 20;
			for (let dy = -3; dy <= 3; dy++)
				for (let dx = -3; dx <= 3; dx++) data.set([250, 240, 200, 255], ((cy + dy) * w + cx + dx) * 4);
		}
	return { width: w, height: h, data };
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	resetCameraMemory();
});

function ctxFor(
	serve: (url: string) => Uint8Array | Error,
	now: () => number,
): FetchContext & { asked: string[] } {
	const dir = mkdtempSync(join(tmpdir(), "vigia-cams-"));
	dirs.push(dir);
	const asked: string[] = [];
	const http: HttpLike = {
		async request(url) {
			asked.push(url);
			const r = serve(url);
			if (r instanceof Error) throw r;
			return {
				url,
				status: 200,
				contentType: "image/jpeg",
				body: Buffer.from(r).toString("base64"),
				fetchedAt: now(),
			};
		},
	};
	return {
		http,
		key: () => undefined,
		now,
		signal: new AbortController().signal,
		blobs: new BlobStore(dir).scope(
			"public-cams",
			publicCams.blobs ?? { maxEntries: 1, maxBytes: 1, maxAgeMs: null },
		),
		asked,
	};
}

test("measure: a blackout empties the lit share of the region while the noisy mean barely moves", () => {
	const on = measure(spec, downscale(nightScene(true), 480, 270), NIGHT);
	const off = measure(spec, downscale(nightScene(false), 480, 270), NIGHT);
	expect(on.night).toBe(true);
	expect(on.lightsBright).toBeGreaterThan(CAMERA_RULES.minBaselineShare);
	expect(off.lightsBright).toBe(0);
	expect(Math.abs((on.lightsMean ?? 0) - (off.lightsMean ?? 0))).toBeLessThan(15);
});

test("stillOf: the operator's bytes are decoded, reduced to 480 px and re-encoded; failures are short codes", async () => {
	const jpeg = encodeJpeg(nightScene(true), 90);
	const withTrailer = new Uint8Array([...jpeg, ...new TextEncoder().encode("<script>")]);
	const ctx = ctxFor(
		() => withTrailer,
		() => NIGHT,
	);
	const r = await stillOf(spec, ctx);
	expect(r).toMatchObject({ camera: "prueba", width: 480, height: 270, reason: null, night: true });
	expect(r.sourceSha).toMatch(/^[0-9a-f]{16}$/);
	const stored = ctx.blobs?.list()[0];
	expect(stored?.width).toBe(480);
	expect(ctx.asked).toEqual(["https://cam.example/current.jpg"]);
	const html = await stillOf(
		spec,
		ctxFor(
			() => new TextEncoder().encode("<html>"),
			() => NIGHT,
		),
	);
	expect(html).toMatchObject({ blob: null, reason: "not-image" });
	const gone = await stillOf(
		spec,
		ctxFor(
			(u) => new HttpError("x", 404, u),
			() => NIGHT,
		),
	);
	expect(gone).toMatchObject({ blob: null, reason: "http-404" });
});

test("the pipeline end to end: six lit nights, then the lights go out; the card turns dark and the panel says so", async () => {
	const store = new Store(":memory:");
	const camera = CAMERAS.find((c) => c.id === "charallave-oeste");
	if (!camera) throw new Error("census");
	let t = NIGHT - 6 * DAY;
	// One encoded still per moment, shared by every camera asked for at that moment: encoding a 960×540 scene per
	// request made this test take 5.4 s on a CI macOS runner (over bun's 5 s budget).
	const stills = new Map<number, Uint8Array>();
	const ctx = ctxFor(
		() => {
			const still = stills.get(t) ?? encodeJpeg(nightScene(t < NIGHT - 30 * MIN, t), 85);
			stills.set(t, still);
			return still;
		},
		() => t,
	);
	const run = async () => {
		resetCameraMemory();
		const obs = publicCams.normalise(await publicCams.fetch(ctx));
		store.insert(obs as Observation[]);
	};
	for (let d = 6; d >= 1; d--) {
		t = NIGHT - d * DAY;
		await run();
	}
	t = NIGHT - 20 * MIN;
	await run();
	t = NIGHT;
	await run();
	const view = camerasView(store, NIGHT + MIN);
	const card = view.cameras.find((c) => c.id === "charallave-oeste");
	expect(card).toMatchObject({ status: "live", entity: "cam.charallave-oeste", state: "VE-M" });
	expect(card?.municipality).toMatch(/^ve\.miranda\./);
	expect(card?.image?.url).toMatch(/^\/api\/blobs\/public-cams\//);
	expect(card?.night).toMatchObject({ status: "dark", nights: 6, darkStills: 2 });
	expect(view.dark).toContain("charallave-oeste");
	// Bonaire's view never gives evidence (abroad), and its card has no state.
	expect(view.cameras.find((c) => c.id === "bonaire-kralendijk")?.state).toBeNull();
	// Embed-only cameras are listed with their player and no still.
	expect(view.cameras.find((c) => c.id === "curazao-willemstad-handelskade")).toMatchObject({
		status: "no-stills",
		image: null,
		play: { type: "youtube", videoId: "28U-t3fA9ks" },
	});
	// "tomada por Vigía" only where Vigía keeps a still; a camera seen only at its operator's never claims one.
	expect(card?.creditEs).toContain("imagen fija tomada por Vigía");
	const embed = view.cameras.find((c) => c.id === "curazao-willemstad-handelskade");
	expect(embed?.creditEs).not.toContain("tomada por Vigía");
	expect(embed?.creditEs).toContain("Vigía no guarda imágenes");
});

test("the census: ids unique, operators named, stills only where the terms allow, Windy duplicates known", () => {
	expect(new Set(CAMERAS.map((c) => c.id)).size).toBe(CAMERAS.length);
	for (const c of CAMERAS) {
		expect(c.id).toMatch(/^[a-z0-9-]+$/);
		expect(c.operator.name.length).toBeGreaterThan(3);
		expect(c.verified).toMatch(/^2026-09-29/);
		if (c.access.type === "youtube" || c.access.type === "embed") expect(c.terms.stills).toBe(false);
		if (c.lights) {
			expect(c.lights.region.x + c.lights.region.w).toBeLessThanOrEqual(1);
			expect(c.lights.region.y + c.lights.region.h).toBeLessThanOrEqual(1);
		}
	}
	expect(stillCameras().map((c) => c.id)).toEqual([
		"charallave-oeste",
		"charallave-este",
		"charallave-norte",
		"charallave-sur",
		"bonaire-kralendijk",
	]);
	for (const id of Object.values(WINDY_DUPLICATES)) expect(CAMERAS.some((c) => c.id === id)).toBe(true);
	const text = cameraRulesText();
	expect(text.es.join(" ")).toContain(`${Math.round(CAMERA_RULES.darkRatio * 100)} %`);
	expect(text.es.join(" ")).toContain("No hay reconocimiento de rostros");
	expect(text.es).toHaveLength(text.en.length);
});

// Real night frames recorded from the operators on 2026-09-29 04:34 UTC, kept out of the repository (the images
// belong to their operators): the regions chosen hold lights, above the baseline floor.
const RECORDED =
	process.env.VIGIA_CAM_FIXTURES ??
	join(import.meta.dir, "..", "..", "runs", "fixtures", "cams", "2026-09-29T0434Z");
test.skipIf(!existsSync(join(RECORDED, "oeste.jpg")))(
	"recorded night frames: the lights regions hold lights",
	() => {
		const at = Date.UTC(2026, 8, 29, 4, 34);
		for (const [file, id] of [
			["oeste.jpg", "charallave-oeste"],
			["este.jpg", "charallave-este"],
			["bq.jpg", "bonaire-kralendijk"],
		] as const) {
			const c = CAMERAS.find((x) => x.id === id);
			if (!c) throw new Error(id);
			const img = decodeImage(new Uint8Array(readFileSync(join(RECORDED, file))));
			const w = Math.min(480, img.width);
			const m = measure(c, downscale(img, w, Math.round((img.height * w) / img.width)), at);
			expect(m.night, id).toBe(true);
			expect(m.lightsBright ?? 0, id).toBeGreaterThan(CAMERA_RULES.minBaselineShare);
		}
	},
);

test("a repeated picture keeps the time it was first seen, and an hourly camera repeating one is frozen", () => {
	const same = { sourceSha: "bbbbbbbbbbbbbbbb" };
	const h = [still(NIGHT - 10 * MIN, same), still(NIGHT, same)];
	expect(cameraState(spec, h, NIGHT)).toMatchObject({ state: "live", firstSeenAt: NIGHT - 10 * MIN });
	const hourly = { ...spec, stillEveryMs: 60 * MIN };
	const two = [still(NIGHT - 60 * MIN, same), still(NIGHT, same)];
	expect(cameraState(hourly, two, NIGHT)).toMatchObject({ state: "frozen", since: NIGHT - 60 * MIN });
});

test("a byte repeat of the newest dark picture keeps the reading dark (the same picture, not a new one)", () => {
	const dark = { lightsBright: 0, sourceSha: "cccccccccccccccc" };
	const h = [
		...nights(0.003),
		still(NIGHT - 30 * MIN, { lightsBright: 0 }),
		still(NIGHT - 10 * MIN, dark),
		still(NIGHT, dark),
	];
	const r = nightReading(spec, h, NIGHT, "live");
	expect(r).toMatchObject({ status: "dark", ratio: 0, darkStills: 2 });
});
