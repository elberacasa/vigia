/**
 * Builds `gadm.json`: which official municipality (INE via OCHA COD-AB) each GADM 4.1 municipality of Venezuela is,
 * because Global Forest Watch's precomputed alert tables key Venezuela by GADM ids (adm1, adm2), not by P-codes.
 *
 * Method: both boundary sets are rasterised on the same grid (the level-7 flood frame, ≈490 m pixels, by pixel
 * centre). Each GADM state takes the official state covering most of its pixels (every one at 84–99 %, measured
 * 2026-09-29; GADM's lines for Venezuela are coarse and shifted). Each GADM municipality is linked to the official
 * municipality covering most of its pixels only when that share is at least MIN_SHARE (0.8) and either the two
 * names agree (accents and spaces folded) or the GADM unit also covers at least MIN_SHARE of the official one: a small
 * GADM unit lying inside a neighbour (El Callao inside Sifontes, share 0.857) never takes its neighbour's name. The
 * others keep their GADM name and only their state.
 *
 * Input: gadm41_VEN_2.json from https://geodata.ucdavis.edu/gadm/gadm4.1/json/ (721,722 bytes, SHA-256
 * 9a38113b…79c6, downloaded 2026-09-29). GADM's licence allows non-commercial use
 * and forbids redistributing its data, so the file is not in the repository; the output is only a table of ids.
 *
 * Run: `bun src/adapters/gfw-alerts/build-gadm.ts path/to/gadm41_VEN_2.json`.
 */
import { join } from "node:path";
import { municipalities } from "../../geo/index.ts";
import { rasterise } from "../../imaging/mask.ts";
import { floodMasks } from "../modis-floods/masks.ts";

type Feature = {
	properties: { GID_1: string; GID_2: string; NAME_1: string; NAME_2: string };
	geometry: { type: "Polygon" | "MultiPolygon"; coordinates: never };
};

/** A GADM municipality is linked to the official one only when this share of its pixels lies in it. */
const MIN_SHARE = 0.8;
const input = process.argv[2];
if (!input) throw new Error("usage: bun src/adapters/gfw-alerts/build-gadm.ts path/to/gadm41_VEN_2.json");
const gadm = (await Bun.file(input).json()) as { features: Feature[] };
const masks = floodMasks();
const labels = rasterise(gadm.features, masks.grid);

/** Pixels of each GADM municipality by COD-AB municipality, and of each GADM state by COD-AB state. */
const counts = gadm.features.map(() => new Map<number, number>());
const totals = gadm.features.map(() => 0);
/** Pixels of each official municipality (1-based label). */
const officialTotals = new Map<number, number>();
for (const m of masks.municipalities) if (m !== 0) officialTotals.set(m, (officialTotals.get(m) ?? 0) + 1);
const stateCounts = new Map<string, Map<string, number>>();
for (let i = 0; i < labels.length; i++) {
	const g = labels[i] ?? 0;
	if (g === 0) continue;
	totals[g - 1] = (totals[g - 1] ?? 0) + 1;
	const m = masks.municipalities[i] ?? 0;
	const c = counts[g - 1];
	if (c) c.set(m, (c.get(m) ?? 0) + 1);
	const a1 = gadm.features[g - 1]?.properties.GID_1 ?? "";
	const s = masks.stateIso[(masks.states[i] ?? 0) - 1] ?? "";
	const sc = stateCounts.get(a1) ?? new Map<string, number>();
	sc.set(s, (sc.get(s) ?? 0) + 1);
	stateCounts.set(a1, sc);
}

const idOf = (gid: string) => gid.replace(/_\d+$/, "").split(".").slice(1).map(Number).join(".");

const states: Record<string, { state: string; share: number; gadmName: string }> = {};
for (const [gid, sc] of stateCounts) {
	const total = [...sc.values()].reduce((a, b) => a + b, 0);
	const [iso = "", n = 0] = [...sc].filter(([k]) => k !== "").sort((a, b) => b[1] - a[1])[0] ?? [];
	const name = gadm.features.find((f) => f.properties.GID_1 === gid)?.properties.NAME_1 ?? "";
	states[idOf(gid)] = { state: iso, share: Math.round((n / total) * 1000) / 1000, gadmName: name };
}

const out: Record<string, { municipality: string | null; share: number; covers: number; gadmName: string }> =
	{};
const officialName = new Map(municipalities().map((m) => [m.code, m.name]));
/** "Julio César Salas" and "JulioCésarSalas" compare equal: accents, spaces and punctuation folded. */
const fold = (t: string) =>
	t
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-z]/gi, "")
		.toLowerCase();
const problems: string[] = [];
for (const [i, f] of gadm.features.entries()) {
	const key = idOf(f.properties.GID_2);
	const best = [...(counts[i] ?? new Map<number, number>())]
		.filter(([m]) => m !== 0)
		.sort((a, b) => b[1] - a[1])[0];
	const total = totals[i] ?? 0;
	const code = best ? (masks.municipalityCode[best[0] - 1] ?? null) : null;
	const share = best && total > 0 ? Math.round((best[1] / total) * 1000) / 1000 : 0;
	// How much of the official municipality this GADM unit covers: a small GADM unit lying inside a neighbour (El
	// Callao inside Sifontes) has a high share but covers little of it, and must not take its name.
	const covers = best ? Math.round((best[1] / (officialTotals.get(best[0]) ?? 1)) * 1000) / 1000 : 0;
	const sameName = code !== null && fold(officialName.get(code) ?? "") === fold(f.properties.NAME_2);
	const linked = share >= MIN_SHARE && (sameName || covers >= MIN_SHARE) ? code : null;
	if (!linked)
		problems.push(
			`${key} ${f.properties.NAME_1}/${f.properties.NAME_2}: best ${code} (${officialName.get(code ?? "")}) at ${share}, covers ${covers}`,
		);
	out[key] = { municipality: linked, share, covers, gadmName: f.properties.NAME_2 };
}
const codes = Object.values(out)
	.map((v) => v.municipality)
	.filter((c) => c !== null);
const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
if (dupes.length) throw new Error(`official municipalities matched twice: ${[...new Set(dupes)].join(", ")}`);
for (const [k, v] of Object.entries(states))
	if (v.share < 0.8) throw new Error(`state ${k} matches at ${v.share}`);

const file = join(import.meta.dir, "gadm.json");
await Bun.write(
	file,
	`${JSON.stringify(
		{
			builtAt: "2026-09-29",
			method:
				"majority of pixels on the level-7 flood frame (≈490 m), GADM 4.1 against COD-AB; share = matched pixels ÷ GADM pixels; covers = matched pixels ÷ official pixels; linked when share ≥ minShare and (same name or covers ≥ minShare)",
			source:
				"GADM 4.1 (gadm41_VEN_2.json, SHA-256 9a38113b4731bc3df1ea9b4270752cd5e368114bff0b47fe17aa4c2fd08079c6)",
			minShare: MIN_SHARE,
			states,
			municipalities: out,
		},
		null,
		"\t",
	)}\n`,
);
console.log(
	`${Object.keys(states).length} states; ${Object.keys(out).length} GADM municipalities, ${codes.length} linked (share ≥ ${MIN_SHARE})`,
);
for (const p of problems) console.log(`  ${p}`);
