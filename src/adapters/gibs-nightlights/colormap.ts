import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { SchemaError } from "../../core/types.ts";

/**
 * GIBS serves classified layers as 8-bit palette PNGs whose palette index is the colormap entry's `ref`
 * (checked: palette[ref] equals the entry's rgb, verified on every tile). So a pixel's value is read by
 * index, and its class interval comes from the layer's published colormap (GIBS ColorMap v1.3 XML), e.g.
 * the night-lights colormap `VIIRS_DayNightBand_At_Sensor_Radiance.xml`: 180 grey classes from
 * [0, 0.1) to [38.2, 999999) nW/(cm²·sr), ref 0 = no data.
 */

export type ColorClass = {
	readonly ref: number;
	readonly rgb: readonly [number, number, number];
	/** Interval of the class in the layer's units; `hi` is Infinity for an open top class. */
	readonly lo: number;
	readonly hi: number;
};

export type ColorMap = {
	readonly title: string;
	readonly units: string | null;
	readonly classes: readonly ColorClass[];
	/** Refs marked nodata. */
	readonly nodata: readonly number[];
};

const Entry = z.object({
	"@_rgb": z.string().regex(/^\d{1,3},\d{1,3},\d{1,3}$/),
	"@_value": z.string().optional(),
	"@_sourceValue": z.string().optional(),
	"@_ref": z.coerce.number().int().min(0).max(255),
	"@_nodata": z.string().optional(),
});
const Map_ = z.object({
	"@_title": z.string(),
	"@_units": z.string().optional(),
	Entries: z.object({ ColorMapEntry: z.array(Entry).or(Entry.transform((e) => [e])) }),
});
const Doc = z.object({ ColorMaps: z.object({ ColorMap: z.array(Map_).or(Map_.transform((m) => [m])) }) });

const INTERVAL = /^([[(])\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(-?\d+(?:\.\d+)?|\+?INF))?\s*([\])])$/i;

export function parseInterval(text: string): { lo: number; hi: number } | null {
	const m = INTERVAL.exec(text.trim());
	if (!m) return null;
	const lo = Number(m[2]);
	const hiText = m[3];
	let hi = hiText === undefined ? lo : /INF/i.test(hiText) ? Number.POSITIVE_INFINITY : Number(hiText);
	// GIBS writes open top classes as [38.2,999999.0).
	if (hi >= 999_999) hi = Number.POSITIVE_INFINITY;
	return Number.isFinite(lo) && hi >= lo ? { lo, hi } : null;
}

/** Parses a GIBS colormap and returns the data classes of the map titled `title`. */
export function parseColorMap(xml: string, title: string): ColorMap {
	let doc: z.infer<typeof Doc>;
	try {
		doc = Doc.parse(new XMLParser({ ignoreAttributes: false }).parse(xml));
	} catch (error) {
		throw new SchemaError(`GIBS colormap: ${error instanceof Error ? error.message : String(error)}`);
	}
	const nodata: number[] = [];
	let data: ColorMap | null = null;
	for (const map of doc.ColorMaps.ColorMap) {
		for (const e of map.Entries.ColorMapEntry) if (e["@_nodata"] === "true") nodata.push(e["@_ref"]);
		if (map["@_title"] !== title) continue;
		const classes: ColorClass[] = [];
		for (const e of map.Entries.ColorMapEntry) {
			if (e["@_nodata"] === "true") continue;
			const interval = parseInterval(e["@_value"] ?? e["@_sourceValue"] ?? "");
			if (!interval) throw new SchemaError(`GIBS colormap: bad interval in ref ${e["@_ref"]}`);
			const [r = 0, g = 0, b = 0] = e["@_rgb"].split(",").map(Number);
			classes.push({ ref: e["@_ref"], rgb: [r, g, b], ...interval });
		}
		data = { title, units: map["@_units"] ?? null, classes, nodata };
	}
	if (!data || data.classes.length === 0) throw new SchemaError(`GIBS colormap: no "${title}" classes`);
	return { ...data, nodata };
}

/**
 * Value per palette index: the class midpoint, or its lower bound for an open top class (so a saturated
 * pixel counts as exactly the ceiling: means are "clipped at the ceiling", said so wherever shown). NaN for
 * no data and unused indices.
 */
export function valueByIndex(map: ColorMap): Float64Array {
	const out = new Float64Array(256).fill(Number.NaN);
	for (const c of map.classes) out[c.ref] = Number.isFinite(c.hi) ? (c.lo + c.hi) / 2 : c.lo;
	return out;
}

/** Throws unless each class's palette colour in the PNG is the colormap's colour (the ref ↔ index contract). */
export function checkPalette(
	map: ColorMap,
	palette: readonly (readonly number[])[] | undefined,
	what: string,
): void {
	if (!palette) throw new SchemaError(`${what}: expected a palette PNG`);
	for (const c of map.classes) {
		const p = palette[c.ref];
		if (!p || p[0] !== c.rgb[0] || p[1] !== c.rgb[1] || p[2] !== c.rgb[2]) {
			throw new SchemaError(`${what}: palette index ${c.ref} does not match the colormap`);
		}
	}
}
