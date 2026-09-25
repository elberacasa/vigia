import { expect, test } from "bun:test";
import { join } from "node:path";
import { hasFixture, loadFixture } from "../../core/fixtures.ts";
import type { RawResponse } from "../../core/types.ts";
import { imfPortwatch, nationalUrl, portsUrl } from "./index.ts";

// Recorded responses carry third-party content, so they are absent from the public repository (see hasFixture).
const FIXTURE = join(import.meta.dir, "fixtures", "2026-09-24");
const recorded = hasFixture(FIXTURE);
const raws = recorded ? loadFixture(FIXTURE) : [];
const [nationalRaw, portsRaw] = raws as [RawResponse, RawResponse];
const obs = recorded ? imfPortwatch.normalise(raws) : [];

test.skipIf(!recorded)("national daily sums and per-port rows; newest day 2026-09-18", () => {
	const ve = obs.filter((o) => o.series === "ve");
	expect(ve.length).toBe(394);
	expect(ve[0]?.value).toEqual({
		date: "2026-09-18",
		portCalls: 11,
		tankerCalls: 5,
		importT: 69254,
		exportT: 31962,
		ports: 18,
	});
	const ports = obs.filter((o) => o.series.startsWith("port:"));
	expect(new Set(ports.map((o) => o.series)).size).toBe(18);
	expect(ports.length).toBe(18 * 15);
	const cabello = ports.find((o) => o.series === "port:port1029" && o.value.date === "2026-09-18");
	expect(cabello?.value).toMatchObject({ name: "Puerto Cabello", portCalls: 3, importT: 46878 });
	// The per-port rows of a day add up to the national row the IMF's own statistics return.
	const day = ports.filter((o) => o.value.date === "2026-09-18");
	expect(day.reduce((s, o) => s + o.value.portCalls, 0)).toBe(11);
	for (const o of obs) {
		expect(o.source).toBe("imf-portwatch");
		expect(o.observedAt).toBeLessThanOrEqual(o.fetchedAt);
		expect(o.location).toBeUndefined();
	}
});

test.skipIf(!recorded)(
	"service errors, truncated per-port answers and a missing national total fail the run",
	() => {
		const err = JSON.stringify({ error: { code: 400, message: "Invalid query" } });
		expect(() => imfPortwatch.normalise([{ ...nationalRaw, body: err }])).toThrow("Invalid query");
		const truncated = JSON.stringify({ features: [], exceededTransferLimit: true });
		expect(() => imfPortwatch.normalise([nationalRaw, { ...portsRaw, body: truncated }])).toThrow("truncada");
		expect(() => imfPortwatch.normalise([portsRaw])).toThrow("totales nacionales");
		const bad = JSON.stringify({ features: [{ attributes: { date: "2026-09-18", calls: -1 } }] });
		expect(() => imfPortwatch.normalise([{ ...nationalRaw, body: bad }])).toThrow("ninguna fila");
	},
);

test("asks only for aggregate Venezuelan rows, never geometry", () => {
	const now = Date.UTC(2026, 8, 24);
	const n = new URL(nationalUrl(now)).searchParams;
	expect(n.get("where")).toBe("ISO3='VEN' AND date >= DATE '2025-08-20'");
	expect(n.get("groupByFieldsForStatistics")).toBe("date");
	const p = new URL(portsUrl(now)).searchParams;
	expect(p.get("returnGeometry")).toBe("false");
	expect(p.get("outFields")).not.toContain("mmsi");
});
