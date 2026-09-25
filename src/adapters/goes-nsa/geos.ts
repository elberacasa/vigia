/**
 * Where a place on Earth lands in NOAA STAR's GOES-19 "nsa" (northern South America) sector image.
 *
 * STAR sector images are not maps: they are cut-outs of the ABI fixed grid, the satellite's own view angles
 * (GOES-R PUG vol. 4, §4.2.8: scan angle x east–west, elevation y north–south, seen from 35 786 km above
 * 75.2° W on the GRS80 ellipsoid). The sector's pixel box is not published, so it was calibrated on
 * 2026-09-24 against the white coast and border lines NOAA burns into the frames: 6 132 points sampled every
 * 0.05° along Natural Earth coasts and borders (src/geo/data/context.geo.json) were projected and the pixel
 * box fitted to four frames (06:00 and 16:00 UTC, 1800×1080 and 3600×2160). With a free pixel size the fit
 * converged to 111.99 × 112.05 µrad per pixel of the 1800-wide image, i.e. the ABI 1-km grid (28 µrad) ÷ 4:
 * the sector is 7200 × 4320 one-km pixels. With the size fixed at 112 µrad the box origin is below; the
 * residual is a quarter of a 1800-px pixel (≈1 km). Verified by eye by reprojecting frames and drawing the
 * state polygons over them (2026-09-24).
 */

/** GRS80 / GOES-R fixed grid constants (GOES-R PUG). */
const EQUATORIAL_M = 6_378_137;
const POLAR_M = 6_356_752.31414;
/** Distance from the Earth's centre to the satellite: perspective height + equatorial radius. */
const SATELLITE_M = 35_786_023 + EQUATORIAL_M;
/** GOES-19 (GOES-East since 2025-04-07). */
export const GOES19_LON_DEG = -75.2;

/** Pixel box of the nsa sector on the 1800-wide image; pixel i covers [i, i+1) (edges on integers). */
export const NSA_SECTOR = {
	width: 1800,
	height: 1080,
	/** Column of scan angle x = 0 (the sub-satellite meridian). */
	u0: 356.56,
	/** Row of elevation y = 0 (the equator at the sub-satellite point). */
	v0: 539.38,
	radPerPx: 112e-6,
} as const;

/** Fixed-grid angles (radians) of a geodetic point, or null when the satellite cannot see it. */
export function fixedGrid(latDeg: number, lonDeg: number): { x: number; y: number } | null {
	const phi = (latDeg * Math.PI) / 180;
	const dLambda = ((lonDeg - GOES19_LON_DEG) * Math.PI) / 180;
	const ratio = (POLAR_M * POLAR_M) / (EQUATORIAL_M * EQUATORIAL_M);
	const phiC = Math.atan(ratio * Math.tan(phi));
	const e2 = 1 - ratio;
	const rc = POLAR_M / Math.sqrt(1 - e2 * Math.cos(phiC) ** 2);
	const sx = SATELLITE_M - rc * Math.cos(phiC) * Math.cos(dLambda);
	const sy = -rc * Math.cos(phiC) * Math.sin(dLambda);
	const sz = rc * Math.sin(phiC);
	// Behind the limb.
	if (SATELLITE_M * (SATELLITE_M - sx) < sy * sy + (sz * sz) / ratio) return null;
	const n = Math.sqrt(sx * sx + sy * sy + sz * sz);
	return { x: Math.asin(-sy / n), y: Math.atan(sz / sx) };
}

/** Continuous pixel coordinates (edge convention) of a point in an nsa image `width` pixels wide. */
export function nsaPixel(latDeg: number, lonDeg: number, width: number): { u: number; v: number } | null {
	const g = fixedGrid(latDeg, lonDeg);
	if (!g) return null;
	const k = width / NSA_SECTOR.width;
	return {
		u: (NSA_SECTOR.u0 + g.x / NSA_SECTOR.radPerPx) * k,
		v: (NSA_SECTOR.v0 - g.y / NSA_SECTOR.radPerPx) * k,
	};
}
