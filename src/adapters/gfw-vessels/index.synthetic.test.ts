import { expect, test } from "bun:test";
import type { FetchContext, HttpLike, RawResponse } from "../../core/types.ts";
import { MissingKeyError } from "../../core/types.ts";
import { registry } from "../../ontology/registry.ts";
import { AREAS, areaPolygon, gfwVessels, reportUrl } from "./index.ts";

// Invented answers in the shape GFW's 4Wings report API documents (no token to record a real one yet).
const now = Date.UTC(2026, 8, 29, 6);
const answer = (area: string, dark: boolean, rows: unknown[]): RawResponse => ({
	url: reportUrl(now, area, dark),
	status: 200,
	contentType: "application/json",
	body: JSON.stringify({
		total: 1,
		limit: null,
		offset: null,
		nextOffset: null,
		metadata: {},
		entries: [{ "public-global-sar-presence:v3.0": rows }],
	}),
	fetchedAt: now,
});

test("daily radar detections per area, with those GFW could not match to AIS", () => {
	const obs = gfwVessels.normalise([
		answer("jose", false, [
			{ date: "2026-09-20", detections: 7 },
			{ date: "2026-09-26", detections: 4 },
			{ date: "2026-09-26", detections: 1 },
			{ date: "bad", detections: 3 },
		]),
		answer("jose", true, [{ date: "2026-09-20", detections: 3 }]),
		answer("paraguana", false, [{ date: "2026-09-26", detections: 2 }]),
	]);
	expect(obs.map((o) => [o.series, o.value.date, o.value.detections, o.value.withoutAis])).toEqual([
		["area:jose", "2026-09-20", 7, 3],
		["area:jose", "2026-09-26", 5, 0],
		["area:paraguana", "2026-09-26", 2, 0],
	]);
	for (const o of obs) {
		expect(o.source).toBe("gfw-vessels");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		// Counts only: nothing that names or places a vessel.
		expect(Object.keys(o.value).sort()).toEqual(["area", "date", "detections", "withoutAis"]);
		expect(o.location).toBeUndefined();
	}
});

test("broken or unexplained answers fail the run", () => {
	expect(() => gfwVessels.normalise([])).toThrow("no response");
	expect(() => gfwVessels.normalise([{ ...answer("jose", false, []), body: "<html>" }])).toThrow("JSON");
	expect(() => gfwVessels.normalise([{ ...answer("jose", false, []), body: '{"error":"x"}' }])).toThrow(
		"entries",
	);
	expect(() =>
		gfwVessels.normalise([{ ...answer("jose", false, []), url: "https://x.invalid/#nowhere" }]),
	).toThrow("desconocida");
	expect(() => gfwVessels.normalise([answer("jose", true, [])])).toThrow("total");
});

test("areas: closed polygons around real terminals, every entity exists in the registry", () => {
	const reg = registry();
	for (const a of AREAS) {
		const ring = areaPolygon(a).coordinates[0] ?? [];
		expect(ring.length).toBeGreaterThanOrEqual(5);
		expect(ring[0]).toEqual(ring.at(-1) as number[]);
		for (const id of a.entities) expect(reg.get(id)?.id).toBe(id);
	}
	const jose = areaPolygon(AREAS[0] as (typeof AREAS)[number]).coordinates[0] ?? [];
	// 12 km east of the centre.
	expect(jose[0]?.[0]).toBeCloseTo(-64.868 + 12 / (111.32 * Math.cos((10.0676 * Math.PI) / 180)), 4);
});

test("locked without a token; the token goes in a header and the area never in GFW's URL", async () => {
	const calls: { url: string; auth?: string | undefined; body?: string | undefined }[] = [];
	const http: HttpLike = {
		request: async (url, opts) => {
			calls.push({ url, auth: opts?.headers?.authorization, body: opts?.body });
			return { url, status: 200, contentType: "application/json", body: '{"entries":[]}', fetchedAt: now };
		},
	};
	const ctx = (key: string | undefined): FetchContext => ({
		http,
		key: () => key,
		now: () => now,
		signal: new AbortController().signal,
	});
	await expect(gfwVessels.fetch(ctx(undefined))).rejects.toBeInstanceOf(MissingKeyError);
	expect(calls.length).toBe(0);
	const raws = await gfwVessels.fetch(ctx("tok.abc.def-1234567890"));
	expect(calls.length).toBe(AREAS.length * 2);
	for (const c of calls) {
		expect(c.url).not.toContain("#");
		expect(c.url).not.toContain("tok.abc");
		expect(c.auth).toBe("Bearer tok.abc.def-1234567890");
		expect(JSON.parse(c.body ?? "{}").geojson.type).toBe("Polygon");
	}
	expect(raws.every((r) => r.url.includes("#"))).toBe(true);
	expect(new URL(calls[1]?.url ?? "").searchParams.get("filters[0]")).toBe("matched='false'");
	expect(new URL(calls[0]?.url ?? "").searchParams.get("date-range")).toBe("2026-08-30,2026-09-29");
});
