import { expect, test } from "bun:test";
import type { FetchContext, HttpLike, RawResponse } from "../../core/types.ts";
import { MissingKeyError } from "../../core/types.ts";
import { anomaliesUrl, cloudflareRadar, outagesUrl, type RadarTraffic, trafficUrl } from "./index.ts";

// Invented payloads in the shape of Cloudflare's published OpenAPI schema (no token to record a real one yet).
const fetchedAt = Date.UTC(2026, 8, 29, 12);
const raw = (url: string, body: unknown): RawResponse => ({
	url,
	status: 200,
	contentType: "application/json",
	body: JSON.stringify(body),
	fetchedAt,
});
const annotation = (over: Record<string, unknown> = {}) => ({
	id: "901",
	dataSource: "ALL",
	description: "Power outage affecting several states",
	scope: "Zulia, Falcón",
	startDate: "2026-09-28T22:15:00Z",
	endDate: null,
	asns: [8048],
	asnsDetails: [{ asn: "8048", name: "CANTV Servicios", location: { code: "VE", name: "Venezuela" } }],
	locations: ["VE"],
	locationsDetails: [{ code: "VE", name: "Venezuela" }],
	geoIds: [],
	entities: [],
	origins: [],
	originsDetails: [],
	eventType: "OUTAGE",
	tags: [],
	linkedUrl: "https://example.invalid/outage-report",
	outage: { outageCause: "POWER_OUTAGE", outageType: "REGIONAL" },
	...over,
});
const anomaly = (over: Record<string, unknown> = {}) => ({
	uuid: "0b1c-anomaly",
	type: "LOCATION",
	status: "VERIFIED",
	startDate: "2026-09-28T22:00:00Z",
	endDate: "2026-09-29T03:00:00Z",
	visibleInDataSources: ["HTTP", "NET"],
	asnDetails: null,
	locationDetails: { code: "VE", name: "Venezuela" },
	originDetails: null,
	...over,
});
const outages = (items: unknown[]) => raw(outagesUrl(), { success: true, result: { annotations: items } });
const anomalies = (items: unknown[]) =>
	raw(anomaliesUrl(), { success: true, result: { trafficAnomalies: items } });
const hour = 3_600_000;
const traffic = (n = 3, extra: Record<string, unknown> = {}) =>
	raw(trafficUrl(), {
		success: true,
		result: {
			meta: {
				aggInterval: "ONE_HOUR",
				normalization: "MIN0_MAX",
				lastUpdated: "2026-09-29T11:45:00Z",
				dateRange: [],
				confidenceInfo: { level: 5, annotations: [] },
				units: [],
			},
			serie_0: {
				timestamps: Array.from({ length: n }, (_, i) => new Date(fetchedAt - (n - i) * hour).toISOString()),
				values: Array.from({ length: n }, (_, i) => String((i + 1) / n)),
			},
			...extra,
		},
	});

test("outages, anomalies and the traffic curve become typed observations", () => {
	const obs = cloudflareRadar.normalise([outages([annotation()]), anomalies([anomaly()]), traffic()]);
	expect(obs.map((o) => o.series)).toEqual(["outage:901", "anomaly:0b1c-anomaly", "traffic:VE"]);
	expect(obs[0]?.value).toEqual({
		kind: "outage",
		id: "901",
		startDate: "2026-09-28T22:15:00.000Z",
		endDate: null,
		description: "Power outage affecting several states",
		scope: "Zulia, Falcón",
		cause: "POWER_OUTAGE",
		outageType: "REGIONAL",
		asns: [{ asn: 8048, name: "CANTV Servicios" }],
		locations: ["VE"],
		linkedUrl: "https://example.invalid/outage-report",
	});
	expect(obs[0]?.basis).toBe("report");
	expect(obs[1]?.value).toMatchObject({
		kind: "anomaly",
		status: "VERIFIED",
		type: "LOCATION",
		location: "VE",
	});
	expect(obs[1]?.confidence).toBe(0.9);
	const t = obs[2]?.value as RadarTraffic;
	expect(t.points.length).toBe(3);
	expect(t.points.at(-1)).toEqual([fetchedAt - hour, 1]);
	expect(obs[2]?.observedAt).toBe(fetchedAt - hour);
	// The bucket still filling (it starts less than an hour before the fetch) is left out.
	const partial = cloudflareRadar.normalise([{ ...traffic(), fetchedAt: fetchedAt - 1 }]);
	expect((partial[0]?.value as RadarTraffic | undefined)?.points.length).toBe(2);
	for (const o of obs) {
		expect(o.source).toBe("cloudflare-radar");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toBe("https://radar.cloudflare.com/ve");
	}
});

test("bad items are skipped; unverified anomalies carry less confidence; AS anomalies keep the network", () => {
	const obs = cloudflareRadar.normalise([
		outages([annotation({ id: 5 }), annotation({ id: "902", startDate: "2027-01-01T00:00:00Z" })]),
		anomalies([
			anomaly({
				uuid: "a2",
				status: "UNVERIFIED",
				type: "AS",
				asnDetails: { asn: "8048", name: "CANTV", location: null },
			}),
			anomaly({ uuid: "a3", status: "MAYBE" }),
		]),
	]);
	expect(obs.map((o) => o.series)).toEqual(["anomaly:a2"]);
	expect(obs[0]?.value).toMatchObject({ asn: 8048, asnName: "CANTV", status: "UNVERIFIED" });
	expect(obs[0]?.confidence).toBe(0.6);
});

test("broken envelopes fail the run", () => {
	expect(() => cloudflareRadar.normalise([])).toThrow("no response");
	expect(() => cloudflareRadar.normalise([{ ...outages([]), body: "<html>" }])).toThrow("no es JSON");
	expect(() =>
		cloudflareRadar.normalise([{ ...outages([]), body: JSON.stringify({ success: false, errors: [] }) }]),
	).toThrow("success");
	expect(() => cloudflareRadar.normalise([raw(outagesUrl(), { success: true, result: {} })])).toThrow(
		"annotations",
	);
	expect(() =>
		cloudflareRadar.normalise([traffic(3, { serie_0: { timestamps: ["x"], values: [] } })]),
	).toThrow("tráfico");
});

test("locked without a token: fetch throws MissingKeyError and never calls the network", async () => {
	let calls = 0;
	const http: HttpLike = {
		request: async () => {
			calls++;
			throw new Error("no network in tests");
		},
	};
	const ctx: FetchContext = {
		http,
		key: () => undefined,
		now: () => fetchedAt,
		signal: new AbortController().signal,
	};
	await expect(cloudflareRadar.fetch(ctx)).rejects.toBeInstanceOf(MissingKeyError);
	expect(calls).toBe(0);
});

test("the token travels in a header, never in a URL", async () => {
	const seen: { url: string; auth: string | undefined }[] = [];
	const http: HttpLike = {
		request: async (url, opts) => {
			seen.push({ url, auth: opts?.headers?.authorization });
			return { url, status: 200, contentType: "application/json", body: "{}", fetchedAt };
		},
	};
	const ctx: FetchContext = {
		http,
		key: () => "tok_abc",
		now: () => fetchedAt,
		signal: new AbortController().signal,
	};
	await cloudflareRadar.fetch(ctx);
	expect(seen.length).toBe(3);
	for (const s of seen) {
		expect(s.url).not.toContain("tok_abc");
		expect(s.auth).toBe("Bearer tok_abc");
		expect(new URL(s.url).searchParams.get("location")).toBe("VE");
	}
});
