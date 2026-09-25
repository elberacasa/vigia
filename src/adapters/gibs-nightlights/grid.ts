import { decode } from "fast-png";
import { SchemaError } from "../../core/types.ts";
import { frameSize, gibsDegPerPx, VENEZUELA_FRAME } from "../../imaging/frame.ts";

/**
 * GIBS EPSG:4326 tiles at level 6: 512-px tiles of 0.0087890625° pixels (≈0.98 km), 4.5° per tile, the grid
 * starting at 90° N, 180° W. Level 6 is an exact nearest-neighbour subsample of the native level 7 (≈490 m):
 * checked on 2026-09-24, every level-6 pixel equals the top-left of its 2×2 level-7 block (262 144 of
 * 262 144), so level-6 values are real pixel values, one in four, not averages of colours.
 *
 * The Venezuela frame (imaging/frame.ts) is tile rows 17–19 × cols 23–26 (12 tiles), cropped from column
 * 284: 1708 × 1536 pixels.
 */
export const LEVEL = 6;
export const TILE_PX = 512;
const DEG = gibsDegPerPx(LEVEL);
const TILE_DEG = DEG * TILE_PX;
export const ROWS = [17, 18, 19] as const;
export const COLS = [23, 24, 25, 26] as const;
export const CROP = {
	x: Math.round((VENEZUELA_FRAME.west - (-180 + (COLS[0] ?? 0) * TILE_DEG)) / DEG),
	y: Math.round((90 - (ROWS[0] ?? 0) * TILE_DEG - VENEZUELA_FRAME.north) / DEG),
	...frameSize(LEVEL),
} as const;

export type Tile = { readonly row: number; readonly col: number; readonly png: Uint8Array };

export type IndexedRaster = {
	readonly width: number;
	readonly height: number;
	/** One palette index per pixel. */
	readonly data: Uint8Array;
	/** RGB(A) of each palette index, as the PNGs declared it. */
	readonly palette: readonly (readonly number[])[];
};

/**
 * Decodes the 12 palette tiles and crops them to the frame. Throws if a tile is missing, is not a palette PNG,
 * or fails `checkPalette` (each tile's palette is checked against the layer's colormap).
 */
export function mosaic(
	tiles: readonly Tile[],
	what: string,
	checkPalette: (palette: readonly (readonly number[])[], tile: string) => void,
): IndexedRaster {
	const width = CROP.width;
	const height = CROP.height;
	const data = new Uint8Array(width * height);
	let palette: (readonly number[])[] | undefined;
	for (const row of ROWS) {
		for (const col of COLS) {
			const tile = tiles.find((t) => t.row === row && t.col === col);
			if (!tile) throw new SchemaError(`${what}: missing tile ${row}/${col}`);
			const png = decode(tile.png);
			if (
				png.width !== TILE_PX ||
				png.height !== TILE_PX ||
				png.channels !== 1 ||
				png.depth !== 8 ||
				!png.palette
			) {
				throw new SchemaError(`${what}: tile ${row}/${col} is not a 512×512 8-bit palette PNG`);
			}
			checkPalette(png.palette, `${what} ${row}/${col}`);
			palette ??= png.palette.map((c) => [...c]);
			const x0 = (col - (COLS[0] ?? 0)) * TILE_PX - CROP.x;
			const y0 = (row - (ROWS[0] ?? 0)) * TILE_PX - CROP.y;
			for (let y = 0; y < TILE_PX; y++) {
				const oy = y0 + y;
				if (oy < 0 || oy >= height) continue;
				const xStart = Math.max(0, -x0);
				const xEnd = Math.min(TILE_PX, width - x0);
				if (xEnd <= xStart) continue;
				data.set(png.data.subarray(y * TILE_PX + xStart, y * TILE_PX + xEnd), oy * width + x0 + xStart);
			}
		}
	}
	return { width, height, data, palette: palette ?? [] };
}
