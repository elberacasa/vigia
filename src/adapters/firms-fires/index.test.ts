import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { areaUrl, firmsFires, parseFirmsCsv } from "./index.ts";

const live = loadFixture(join(import.meta.dir, "fixtures", "2026-09-24"));
const withBody = (body: string, url?: string): RawResponse => ({
	...(live[0] as RawResponse),
	body,
	...(url ? { url } : {}),
});
const HEADER =
	"latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

test("normalises the live South America file: Venezuela and 50 km around it, plus one file record", () => {
	const obs = firmsFires.normalise(live);
	const detections = obs.filter((o) => o.value.kind === "detection");
	expect(detections.length).toBe(741);
	expect(detections.filter((o) => o.value.kind === "detection" && o.value.inVenezuela).length).toBe(672);
	const file = obs.find((o) => o.series === "firms:file");
	expect(file?.value).toMatchObject({ kind: "file", rows: 20360, invalidRows: 0, kept: 741 });
	// "24h" really spans 39.8 h here: 2026-09-23 03:42 to 2026-09-24 19:28 UTC.
	if (file?.value.kind === "file") {
		expect(file.value.oldestAcqAt).toBe(Date.UTC(2026, 8, 23, 3, 42));
		expect(file.value.newestAcqAt).toBe(Date.UTC(2026, 8, 24, 19, 28));
	}
	for (const o of obs) {
		expect(o.source).toBe("firms-fires");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://firms.modaps.eosdis.nasa.gov/");
		if (o.value.kind === "detection") {
			expect(o.value.inVenezuela || o.value.borderKm <= 50).toBe(true);
			if (o.value.inVenezuela) expect(o.location?.state).toMatch(/^VE-[A-Z]$/);
		}
	}
});

test("series id, UTC time and confidence mapping of one row", () => {
	const csv = `${HEADER}\n9.64720,-63.56690,367.1,0.39,0.36,2026-09-24,547,N20,high,2.0NRT,300.1,25.5,N\n`;
	const [o] = firmsFires.normalise([withBody(csv)]);
	expect(o?.series).toBe("fire:N20:2026-09-24T0547Z:9.64720:-63.56690");
	expect(o?.observedAt).toBe(Date.UTC(2026, 8, 24, 5, 47)); // "547" = 05:47 UTC
	expect(o?.confidence).toBe(0.95);
	expect(o?.location?.state).toBe("VE-N"); // Monagas
	expect(o?.value).toMatchObject({ confidenceClass: "high", frpMW: 25.5, daynight: "night" });
});

test("rows outside the area or far from the border are dropped", () => {
	const csv = [
		HEADER,
		"-3.2,-46.9,335,0.78,0.78,2026-09-24,0342,N20,nominal,2.0NRT,289,16.7,N", // Brazil, far south
		"4.6,-74.1,335,0.78,0.78,2026-09-24,0342,N20,nominal,2.0NRT,289,16.7,N", // Bogotá, >50 km
		"7.77,-72.23,335,0.78,0.78,2026-09-24,0342,N20,nominal,2.0NRT,289,16.7,N", // San Cristóbal
	].join("\n");
	const obs = firmsFires.normalise([withBody(csv)]).filter((o) => o.value.kind === "detection");
	expect(obs.length).toBe(1);
	expect(obs[0]?.location?.state).toBe("VE-S");
});

test("MODIS numeric confidence and old l/n/h letters are classed like FIRMS does", () => {
	const modis =
		"latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n" +
		"8.1,-63.5,311,1.2,1.1,2026-09-23,0001,T,81,6.1NRT,296,11,N\n8.1,-63.6,311,1.2,1.1,2026-09-23,0001,T,29,6.1NRT,296,11,N\n";
	expect(parseFirmsCsv(modis).rows.map((r) => r.confidence)).toEqual(["high", "low"]);
	const letters = `${HEADER}\n8.1,-63.5,330,0.4,0.4,2026-09-23,1810,N,n,2.0NRT,290,3,D\n`;
	expect(parseFirmsCsv(letters).rows[0]?.confidence).toBe("nominal");
});

test("a malformed row is skipped; mostly malformed or missing columns fail", () => {
	const lines = live[0]?.body.split("\n") ?? [];
	lines[1] = "garbage,row";
	expect(parseFirmsCsv(lines.join("\n")).invalid).toBe(1);
	expect(() => firmsFires.normalise([withBody("latitude,longitude\n1,2\n")])).toThrow("missing columns");
	const bad = `${HEADER}\n${"x,y,z,1,1,2026-09-24,0100,N20,nominal,2,1,1,N\n".repeat(3)}`;
	expect(() => firmsFires.normalise([withBody(bad)])).toThrow("rows invalid");
});

test("an HTML page or the API's key error is not a CSV", () => {
	expect(() => firmsFires.normalise([withBody("<html>maintenance</html>")])).toThrow("not a CSV");
	expect(() => firmsFires.normalise([withBody("Invalid MAP_KEY.")])).toThrow("not a CSV");
});

test("an empty file (header only) is valid and yields nothing", () => {
	expect(firmsFires.normalise([withBody(`${HEADER}\n`)])).toEqual([]);
});

test("with a key, the area API is used and the key never reaches the recorded URL", async () => {
	const key = "abcdef0123456789abcdef0123456789";
	expect(areaUrl(key)).toBe(
		`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/-74,0,-59,13.5/2`,
	);
	let requested = "";
	const raws = await firmsFires.fetch({
		http: {
			request: async (url) => {
				requested = url;
				return { url, status: 200, contentType: "text/csv", body: `${HEADER}\n`, fetchedAt: 1 };
			},
		},
		key: (id) => (id === "nasa-firms-map-key" ? key : undefined),
		now: () => 1,
		signal: new AbortController().signal,
	});
	expect(requested).toContain(key);
	expect(raws[0]?.url).not.toContain(key);
	expect(raws[0]?.url).toContain("/api/area/csv/MAP_KEY/");
});

test("key validation: a rejected key and a valid status response", async () => {
	const { firmsMapKey } = await import("./key.ts");
	const reply = (status: number, body: string) => ({
		request: async (url: string) => ({ url, status, contentType: "text/plain", body, fetchedAt: 1 }),
	});
	// Real reply to an invalid key, measured 2026-09-24 (HTTP 403).
	const invalid =
		"MAP_KEY is invalid or your have exceeded your transaction/time limit. Please try again later.";
	expect(await firmsMapKey.validate("0123456789abcdef0123456789abcdef", reply(403, invalid))).toContain(
		"no reconoce",
	);
	expect(
		await firmsMapKey.validate(
			"0123456789abcdef0123456789abcdef",
			reply(200, '{"transaction_limit":5000,"current_transactions":0}'),
		),
	).toBeNull();
	expect(await firmsMapKey.validate("not a key!", reply(200, "{}"))).toContain("letras");
});
