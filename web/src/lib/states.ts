import { STATES } from "../map/geometry.gen.ts";

const NAMES = new Map(STATES.map((s) => [s.iso, s.name]));

export function stateName(iso: string | null | undefined): string {
	return iso ? (NAMES.get(iso) ?? iso) : "";
}
