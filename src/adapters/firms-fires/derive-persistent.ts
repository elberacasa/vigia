/**
 * Derives the list of persistent heat sources (gas flares, refineries, other industry) that the fires panel uses
 * to label detections, from a FIRMS 7-day file of the same sensor:
 *
 *   curl -o J1_7d.csv https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_7d.csv
 *   bun src/adapters/firms-fires/derive-persistent.ts J1_7d.csv > src/adapters/firms-fires/persistent-sources.json
 *
 * Rule: a 0.01° cell (~1.1 km, about three VIIRS 375 m pixels) is persistent when it has detections on at least
 * MIN_DAYS distinct UTC dates of the file (a 7-day file touches 8 dates). Neighbouring persistent cells (8-way)
 * merge into one source. A vegetation fire rarely burns in the same square kilometre on 4 of 8 days; a gas flare
 * or a refinery stack does, day and night. Only sources in Venezuela or within 50 km of it are kept.
 */
import { readFileSync } from "node:fs";
import { distanceKm } from "../../geo/index.ts";
import { placeOf } from "../../geo/place.ts";
import { parseFirmsCsv } from "./index.ts";

export const MIN_DAYS = 4;
const CELL = 0.01;

const path = process.argv[2];
if (!path) {
	console.error("Uso: bun src/adapters/firms-fires/derive-persistent.ts <7d.csv>");
	process.exit(1);
}
const { rows } = parseFirmsCsv(readFileSync(path, "utf8"));
const near = rows.filter((r) => r.lat >= 0 && r.lat <= 13.5 && r.lon >= -74 && r.lon <= -59);
const dates = [...new Set(near.map((r) => r.acqDate))].sort();

const key = (a: number, b: number) => `${a},${b}`;
const cells = new Map<string, typeof near>();
for (const r of near) {
	const k = key(Math.round(r.lat / CELL), Math.round(r.lon / CELL));
	const list = cells.get(k);
	if (list) list.push(r);
	else cells.set(k, [r]);
}
const persistent = new Set(
	[...cells].filter(([, list]) => new Set(list.map((r) => r.acqDate)).size >= MIN_DAYS).map(([k]) => k),
);

const seen = new Set<string>();
const sources = [];
for (const start of [...persistent].sort()) {
	if (seen.has(start)) continue;
	seen.add(start);
	const stack = [start];
	const members: typeof near = [];
	while (stack.length) {
		const k = stack.pop() as string;
		members.push(...(cells.get(k) ?? []));
		const [a = 0, b = 0] = k.split(",").map(Number);
		for (let i = -1; i <= 1; i++)
			for (let j = -1; j <= 1; j++) {
				const n = key(a + i, b + j);
				if (persistent.has(n) && !seen.has(n)) {
					seen.add(n);
					stack.push(n);
				}
			}
	}
	const lat = members.reduce((s, r) => s + r.lat, 0) / members.length;
	const lon = members.reduce((s, r) => s + r.lon, 0) / members.length;
	const where = placeOf(lat, lon);
	if (!where.inVenezuela && where.borderKm > 50) continue;
	const radiusKm = Math.max(...members.map((r) => distanceKm(lat, lon, r.lat, r.lon)));
	sources.push({
		lat: Math.round(lat * 1e4) / 1e4,
		lon: Math.round(lon * 1e4) / 1e4,
		radiusKm: Math.round(radiusKm * 100) / 100,
		days: new Set(members.map((r) => r.acqDate)).size,
		detections: members.length,
		nightDetections: members.filter((r) => r.daynight === "N").length,
		state: where.state,
		country: where.country,
	});
}
sources.sort((a, b) => b.detections - a.detections);
console.log(
	JSON.stringify(
		{
			derivedFrom: "NASA FIRMS NOAA-20 VIIRS South America 7d",
			dates,
			rule: `0.01° cells with detections on >= ${MIN_DAYS} distinct dates, 8-neighbour merge`,
			sources: sources.map((s, i) => ({ id: `ps${String(i + 1).padStart(3, "0")}`, ...s })),
		},
		null,
		1,
	),
);
