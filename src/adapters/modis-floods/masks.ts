import municipalitiesJson from "../../geo/data/municipalities.geo.json" with { type: "json" };
import statesJson from "../../geo/data/states.geo.json" with { type: "json" };
import { frameSize, VENEZUELA_FRAME } from "../../imaging/frame.ts";
import { type Grid, type MaskFeature, rasterise, rowAreasKm2 } from "../../imaging/mask.ts";

/**
 * State and municipality masks of the level-7 Venezuela frame (3416 × 3072 pixels of 0.00439°), rasterised once
 * by pixel centre from the official boundaries (INE via OCHA COD-AB, src/geo/data), and each row's pixel area.
 * OCHA's placeholder municipality VE2501 (Dependencias Federales, no municipalities) is left out of the municipality
 * mask; its islands still count for the state.
 */

type Props = { code: string; iso3166_2?: string; placeholder?: boolean };
type Feature = MaskFeature & { properties: Props };

export type FloodMasks = {
	readonly grid: Grid;
	/** 1-based index into `stateIso`, 0 outside Venezuela. */
	readonly states: Uint16Array;
	readonly stateIso: readonly string[];
	/** 1-based index into `municipalityCode`, 0 outside every municipality. */
	readonly municipalities: Uint16Array;
	readonly municipalityCode: readonly string[];
	readonly rowArea: Float64Array;
};

/**
 * Built on each call (≈30 ms, measured 2026-09-29) and not kept: the two masks weigh 42 MB, and the flood feed needs
 * them once every three hours.
 */
export function floodMasks(): FloodMasks {
	const grid: Grid = { ...frameSize(7), bounds: VENEZUELA_FRAME };
	const states = (statesJson as unknown as { features: Feature[] }).features;
	const munis = (municipalitiesJson as unknown as { features: Feature[] }).features.filter(
		(f) => !f.properties.placeholder && f.properties.code !== "VE2501",
	);
	return {
		grid,
		states: rasterise(states, grid),
		stateIso: states.map((f) => f.properties.iso3166_2 ?? ""),
		municipalities: rasterise(munis, grid),
		municipalityCode: munis.map((f) => f.properties.code),
		rowArea: rowAreasKm2(grid),
	};
}
