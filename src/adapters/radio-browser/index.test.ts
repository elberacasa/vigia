import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { SchemaError } from "../../core/types.ts";
import type { AudioProbe } from "../../media/probe.ts";
import {
	audioReading,
	buildDirectory,
	frequencyOf,
	PROBE_CONTENT_TYPE,
	type RadioEntry,
	radioBrowser,
	radioBrowserProbe,
	stationStates,
} from "./index.ts";

// Recorded 2026-09-29 ~02:00 UTC (28 Sep, Caracas time): de1.api.radio-browser.info, 203 stations listed for VE.
// Internal only: the community list holds web radios whose names carry private handles (see the export policy).
const LIST = join(import.meta.dir, "fixtures", "2026-09-28");
const PROBE = join(import.meta.dir, "fixtures", "probe-2026-09-28");

describe("radio-browser: the recorded directory", () => {
	test.skipIf(!hasFixture(LIST))(
		"203 listed → 123 broadcasters; web-only and handles counted, never stored",
		() => {
			const obs = radioBrowser.normalise(loadFixture(LIST));
			const summary = obs.find((o) => o.series === "rb:summary")?.value;
			expect(summary).toEqual({
				listed: 203,
				broadcasters: 123,
				webOnly: 60,
				withHandle: 10,
				duplicates: 10,
			});
			const entries = obs.filter((o) => o.series !== "rb:summary").map((o) => o.value as RadioEntry);
			expect(entries).toHaveLength(123);
			expect(entries.filter((e) => e.status === "on")).toHaveLength(120);
			// The curated stations whose listing names no frequency.
			expect(
				entries
					.filter((e) => e.curatedWhy)
					.map((e) => [e.name, e.frequency])
					.sort(),
			).toEqual([
				["KYS FM", "101.5 FM"],
				["Radio María Venezuela", "1450 AM"],
				["Tama Stereo", "103.9 FM"],
			]);
			const text = JSON.stringify(obs);
			expect(text).not.toMatch(/@|Ig:|highrise|Nezux/i);
			expect(entries.filter((e) => e.ownership === "state").map((e) => e.name)).toContain(
				"Radio Nacional de Venezuela - Informativa",
			);
			// A stream re-served by a third-party proxy is not played.
			expect(entries.find((e) => e.name.startsWith("Maturín - Fe y Alegría"))).toMatchObject({
				status: "excluded",
				reason: "relay",
				reasonDetail: "worldradio.online",
			});
			expect(entries.find((e) => e.name.startsWith("Radio Dinámica 1490"))?.frequency).toBe("1490 AM");
			expect(text).not.toContain("Ã");
			for (const o of obs) {
				expect(o.source).toBe("radio-browser");
				expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
				expect(o.sourceUrl).toStartWith("https://www.radio-browser.info/");
			}
		},
	);
});

// Invented stations in Radio Browser's format (no real station, person or handle).
const station = (over: Record<string, unknown>) => ({
	changeuuid: "00000000-0000-4000-8000-000000000000",
	stationuuid: "11111111-1111-4111-8111-111111111111",
	name: "Ejemplo 99.9 FM",
	url: "https://radio.example/stream",
	url_resolved: "https://radio.example/stream",
	homepage: "https://radio.example/",
	countrycode: "VE",
	iso_3166_2: null,
	state: "",
	codec: "MP3",
	bitrate: 128,
	hls: 0,
	votes: 3,
	lastchangetime_iso8601: "2026-09-20T10:00:00Z",
	geo_lat: null,
	geo_long: null,
	...over,
});
const st2 = (n: number, name: string, url: string, homepage: string) =>
	station({ stationuuid: uuid(n), name, url_resolved: url, homepage });
const uuid = (n: number) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;

describe("radio-browser: the rule (synthetic)", () => {
	const body = JSON.stringify([
		station({ stationuuid: uuid(1), name: "\tOnda Ejemplo 101.5 FM", state: "Estado Lara" }),
		station({
			stationuuid: uuid(2),
			name: "Radio Prueba 1250 AM",
			url_resolved: "http://am.example/live",
			iso_3166_2: "VE-V",
		}),
		station({
			stationuuid: uuid(3),
			name: "Magic Ejemplo 92.5 Maracay",
			url_resolved: "https://m.example/s",
		}),
		station({ stationuuid: uuid(4), name: "Mi radio @alguien", url_resolved: "https://p.example/s" }),
		station({ stationuuid: uuid(5), name: "Clásicos en la web", url_resolved: "https://w.example/s" }),
		station({ stationuuid: uuid(6), name: "Copia 99.9 FM", votes: 0 }),
		station({
			stationuuid: uuid(7),
			name: "Relevo 90.1 FM",
			url_resolved: "https://worldradio.online/proxy/?q=http://x",
		}),
		station({
			stationuuid: uuid(8),
			name: "Radio Nacional de Venezuela - Prueba",
			url_resolved: "https://rnv.example/s",
		}),
		station({
			stationuuid: uuid(9),
			name: "Punto 95.1 FM",
			url_resolved: "https://g.example/s",
			geo_lat: 10.65,
			geo_long: -71.64,
		}),
		station({
			stationuuid: uuid(10),
			name: "Otro País 98.1 FM",
			countrycode: "CO",
			url_resolved: "https://co.example/s",
		}),
		station({ stationuuid: uuid(11), name: "Radio DinÃ¡mica 88.8 FM", url_resolved: "https://d.example/s" }),
		{ stationuuid: "not-a-uuid" },
	]);
	const dir = buildDirectory(body);
	const byName = (n: string) => dir.entries.find((e) => e.name === n);

	test("broadcasters kept; web-only, handles and duplicates counted; other countries ignored", () => {
		expect(dir.summary).toEqual({ listed: 10, broadcasters: 7, webOnly: 1, withHandle: 1, duplicates: 1 });
		expect(dir.entries.map((e) => e.name)).toEqual([
			"Magic Ejemplo 92.5 Maracay",
			"Onda Ejemplo 101.5 FM",
			"Punto 95.1 FM",
			"Radio Dinámica 88.8 FM",
			"Radio Nacional de Venezuela - Prueba",
			"Radio Prueba 1250 AM",
			"Relevo 90.1 FM",
		]);
		expect(JSON.stringify(dir)).not.toContain("alguien");
		// The most-voted listing of a duplicated stream is the one kept.
		expect(dir.entries.some((e) => e.name === "Copia 99.9 FM")).toBe(false);
	});

	test("frequency, state, ownership, relay and HTTPS", () => {
		expect(byName("Onda Ejemplo 101.5 FM")).toMatchObject({
			frequency: "101.5 FM",
			states: ["VE-K"],
			statesFrom: "state-field",
		});
		expect(byName("Radio Prueba 1250 AM")).toMatchObject({
			frequency: "1250 AM",
			states: ["VE-V"],
			statesFrom: "iso",
			https: false,
		});
		expect(byName("Magic Ejemplo 92.5 Maracay")).toMatchObject({
			frequency: "92.5 FM",
			states: ["VE-D"],
			statesFrom: "name",
		});
		expect(byName("Punto 95.1 FM")).toMatchObject({ states: ["VE-V"], statesFrom: "geo" });
		expect(byName("Radio Nacional de Venezuela - Prueba")).toMatchObject({
			ownership: "state",
			frequency: null,
		});
		expect(byName("Relevo 90.1 FM")).toMatchObject({ status: "excluded", reason: "relay" });
		expect(dir.version).toBe(Date.parse("2026-09-20T10:00:00Z"));
	});

	test("a curated station is kept though its listing names no frequency, with the reference", () => {
		const d = buildDirectory(
			JSON.stringify([
				st2(21, "Kys Ejemplo", "https://kys.example/s", "http://www.kysfm.com/"),
				st2(22, "Sin frecuencia", "https://w.example/s", "https://sinfrecuencia.example/"),
			]),
		);
		expect(d.entries).toEqual([
			expect.objectContaining({
				name: "Kys Ejemplo",
				frequency: "101.5 FM",
				states: ["VE-M"],
				statesFrom: "curated",
				curatedWhy: expect.stringContaining("cvir.com.ve"),
			}),
		]);
		expect(d.summary.webOnly).toBe(1);
	});

	test("frequencies and states from the fields a station fills", () => {
		expect(frequencyOf("Sabor 106,7 fm")).toBe("106.7 FM");
		expect(frequencyOf("FM 97.1 Ejemplo")).toBe("97.1 FM");
		expect(frequencyOf("Radio 2000")).toBeNull();
		expect(frequencyOf("Canal 12.5")).toBeNull();
		expect(
			stationStates({ iso_3166_2: null, geo_lat: null, geo_long: null, state: "Bolivar", name: "x" }).states,
		).toEqual(["VE-F"]);
		expect(
			stationStates({ iso_3166_2: null, geo_lat: 4.6, geo_long: -74.1, state: "", name: "x" }).states,
		).toEqual([]);
	});

	test("the envelope must be a list with at least one Venezuelan station", () => {
		expect(() => buildDirectory("<html>")).toThrow(SchemaError);
		expect(() => buildDirectory("[]")).toThrow(SchemaError);
		expect(() => buildDirectory(JSON.stringify([station({ countrycode: "CO" })]))).toThrow(SchemaError);
		expect(() => radioBrowser.normalise([])).toThrow(SchemaError);
	});

	test("normalise: one observation per broadcaster plus the counts, dated by the newest listing change", () => {
		const raw: RawResponse = {
			url: "https://de1.api.radio-browser.info/json/stations/bycountrycodeexact/VE",
			status: 200,
			contentType: "application/json",
			body,
			fetchedAt: Date.parse("2026-09-28T12:00:00Z"),
		};
		const obs = radioBrowser.normalise([raw]);
		expect(obs).toHaveLength(8);
		expect(new Set(obs.map((o) => o.observedAt))).toEqual(new Set([Date.parse("2026-09-20T10:00:00Z")]));
	});
});

describe("radio-browser-probe", () => {
	test.skipIf(!hasFixture(PROBE))(
		"replays the recorded round: 117 streams, 102 sending audio, 830 KB read",
		() => {
			const obs = radioBrowserProbe.normalise(loadFixture(PROBE));
			expect(obs).toHaveLength(117);
			expect(obs.filter((o) => o.value.state === "live")).toHaveLength(102);
			expect(obs.reduce((n, o) => n + o.value.bytes, 0)).toBe(829_867);
			for (const o of obs) {
				expect(o.series).toBe(`rbp:${o.value.uuid}`);
				expect(o.basis).toBe("measurement");
				expect(o.value.origins.length).toBeGreaterThan(0);
			}
			expect(obs.find((o) => o.value.kind === "hls")?.value).toMatchObject({ state: "live", cors: true });
		},
	);

	const probe: AudioProbe = {
		url: "https://radio.example/stream",
		at: 1,
		httpStatus: 200,
		contentType: "audio/mpeg",
		bytes: 8192,
		audioFrames: true,
		origin: "https://radio.example",
		ms: 300,
		error: null,
	};

	test("the audio rule, with the error status kept", () => {
		expect(audioReading(probe)).toEqual({ state: "live", reason: null });
		expect(audioReading({ ...probe, httpStatus: 503, error: "http-503", bytes: 0 })).toEqual({
			state: "not-live",
			reason: "http-503",
		});
		expect(audioReading({ ...probe, httpStatus: null, error: "timeout", bytes: 0 })).toEqual({
			state: "no-answer",
			reason: "timeout",
		});
		expect(audioReading({ ...probe, contentType: "text/html", audioFrames: false })).toEqual({
			state: "not-live",
			reason: "no-audio-frames",
		});
		expect(audioReading({ ...probe, bytes: 1000 }).state).toBe("not-live");
	});

	test("a malformed record is skipped; none valid fails the run", () => {
		const bad: RawResponse = {
			url: "x",
			status: 200,
			contentType: PROBE_CONTENT_TYPE,
			body: '{"kind":"audio"}',
			fetchedAt: 1,
		};
		const good: RawResponse = {
			...bad,
			body: JSON.stringify({ kind: "audio", uuid: uuid(1), probe }),
		};
		expect(radioBrowserProbe.normalise([bad, good])).toHaveLength(1);
		expect(() => radioBrowserProbe.normalise([bad])).toThrow(SchemaError);
	});
});
