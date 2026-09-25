import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { distanceToOutlineKm, FACILITIES, facilityFor } from "./facilities.ts";
import { type FlareDetection, type FlareFile, firmsFlares } from "./index.ts";

// Recorded 2026-09-25 01:58 UTC; trimmed to Venezuela's box plus the file's oldest and newest rows (8.0 MB → 249 KB).
const raws = loadFixture(join(import.meta.dir, "fixtures", "2026-09-25"));
const [raw] = raws as [RawResponse];
const obs = firmsFlares.normalise(raws);
const detections = obs.filter((o) => o.value.kind === "detection") as { value: FlareDetection }[];
const file = obs.find((o) => o.series === "flares:file")?.value as FlareFile;

test("the 7-day file: 1,002 detections at facilities, file span kept", () => {
	expect(detections.length).toBe(1002);
	expect(file.rows).toBe(2995);
	expect(file.kept).toBe(1002);
	expect(new Date(file.oldestAcqAt).toISOString()).toBe("2026-09-17T03:53:00.000Z");
	expect(new Date(file.newestAcqAt).toISOString()).toBe("2026-09-24T19:28:00.000Z");
	for (const o of obs) {
		expect(o.source).toBe("firms-flares");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.sourceUrl).toStartWith("https://firms.modaps.eosdis.nasa.gov/");
	}
});

test("per facility: Santa Bárbara and Cardón lit every night, El Palito almost dark", () => {
	const nights = (id: string) =>
		new Set(
			detections
				.filter((d) => d.value.facilityId === id && d.value.daynight === "night")
				.map((d) => d.value.acqDate),
		).size;
	expect(nights("santa-barbara")).toBe(8);
	expect(nights("cardon")).toBe(8);
	expect(nights("amuay")).toBe(8);
	expect(nights("el-palito")).toBe(1);
	const first = obs[0];
	expect(first?.series).toBe("fire:N20:2026-09-17T0531Z:11.74286:-70.20315");
	expect(first?.value).toMatchObject({ facilityId: "amuay", facilityKm: 0, frpMW: 1.55, daynight: "night" });
	expect(first?.location).toMatchObject({ state: "VE-I", place: "Refinería Amuay (CRP)" });
});

test("facility rule: inside an outline is 0 km, the buffer is 1 km, sites 1.5 km, far points match nothing", () => {
	const amuay = FACILITIES.find((f) => f.id === "amuay");
	expect(amuay?.outline?.length).toBeGreaterThan(10);
	expect(facilityFor(11.7487, -70.2018)?.facility.id).toBe("amuay");
	expect(facilityFor(11.7487, -70.2018)?.km).toBe(0);
	// TermoCarabobo power plant, ~2 km west of El Palito's outline: not the refinery.
	expect(facilityFor(10.4838, -68.1494)?.facility.id).not.toBe("el-palito");
	// Bolívar savanna.
	expect(facilityFor(7.66, -63.15)).toBeNull();
	// Carito–Mulata's biggest persistent source (fires panel ps001).
	expect(facilityFor(9.6472, -63.5669)?.facility.id).toBe("carito-mulata");
	// A square: 0 inside, ~1.1 km at 0.01° outside the east edge.
	const sq: [number, number][] = [
		[10, -64],
		[10, -63.9],
		[10.1, -63.9],
		[10.1, -64],
	];
	expect(distanceToOutlineKm(10.05, -63.95, sq)).toBe(0);
	expect(distanceToOutlineKm(10.05, -63.89, sq)).toBeCloseTo(1.096, 2);
});

test("an HTML error page fails the run; a bad row is skipped", () => {
	expect(() => firmsFlares.normalise([{ ...raw, body: "<html>maintenance</html>" }])).toThrow("not a CSV");
	const lines = raw.body.trimEnd().split("\n");
	const broken = [...lines, "abc,def,1,1,1,2026-09-24,0600,N20,n,2.0NRT,290,5,N"].join("\n");
	expect(firmsFlares.normalise([{ ...raw, body: broken }]).length).toBe(obs.length);
});

test("detections stamped after the fetch (clock skew beyond 10 min) are dropped", () => {
	const lines = raw.body.trimEnd().split("\n");
	const future = [...lines, "11.7487,-70.2018,330,0.4,0.4,2026-09-26,0600,N20,n,2.0NRT,290,5,N"].join("\n");
	expect(firmsFlares.normalise([{ ...raw, body: future }]).length).toBe(obs.length);
});
