import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import contracts from "../data/contracts.json";
import facts from "../data/facts.json";
import type { Lang } from "./i18n";

/**
 * Everything the page states as a fact comes from these files, written by `bun scripts/site-data.ts` in the
 * repository root: numbers derived from the code, and output captured from a running Vigía.
 */
export { contracts, facts };

const captures = join(process.cwd(), "src", "data", "captures");

export function terminal(lang: Lang): string {
	return readFileSync(join(captures, `terminal-${lang}.txt`), "utf8");
}

export interface ApiFigure {
	panel: string;
	path: string;
	value: number;
	feed: string;
	sourceUrl: string;
	observedAt: number;
	fetchedAt: number;
	stale: boolean;
	licence: string;
	licenceUrl: string;
	attribution: string;
}

export function apiFigure(): { raw: string; figure: ApiFigure } {
	const raw = readFileSync(join(captures, "api-figure.json"), "utf8");
	return { raw, figure: JSON.parse(raw) as ApiFigure };
}

export const capturedAt = (
	JSON.parse(readFileSync(join(captures, "meta.json"), "utf8")) as { capturedAt: number }
).capturedAt;
