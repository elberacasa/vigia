import { MB_PER_DAY, MEASURED_AT, UNMEASURED } from "./bandwidth.gen.ts";
import { type DeployMode, onByDefault } from "./defaults.ts";
import type { Adapter } from "./types.ts";

/**
 * What Vigía downloads in a day, and the data saver ("Conexión limitada") built on it.
 *
 * The figures are measured, not guessed: `bun scripts/bandwidth.ts` runs every feed once through the scheduler's
 * byte meter and multiplies by its runs a day (docs/PERF.md, "Daily download per feed"); the result is
 * bandwidth.gen.ts. A feed is **heavy** when it downloads at least `HEAVY_MB_PER_DAY` a day at its default interval.
 * The threshold, not a hand-picked list, decides; a test keeps the set honest when feeds change.
 *
 * The data saver turns the heavy feeds off. Order of precedence for a feed's switch:
 *   1. the user's own switch for that feed (config.json `feeds`), always;
 *   2. the data saver, when on: heavy feeds off;
 *   3. the feed's default for the deployment mode (core/defaults.ts).
 * The data saver itself: `--data-saver` / `VIGIA_DATA_SAVER` when set (1 or 0), else config.json `dataSaver`, else
 * off. On a person's own Vigía an unset value means "not asked yet": the page asks once, on first run.
 */

/** A feed downloading this much a day or more is heavy (the data saver turns it off). */
export const HEAVY_MB_PER_DAY = 20;

export { MEASURED_AT };

/**
 * Feeds whose download changes with an optional key: with it, the figure here replaces the keyless one.
 * `mb: null`: not measured with the key; the adapter's notes bound it.
 */
const WITH_KEY: Readonly<
	Record<string, { readonly key: string; readonly mb: number | null; readonly why: string }>
> = {
	"firms-fires": {
		key: "nasa-firms-map-key",
		mb: null,
		why: "with a MAP_KEY the area API returns Venezuela's box only, tens of KB an hour (firms-fires/key.ts), well under the threshold",
	},
};

/**
 * Feeds that download nothing without the optional ffmpeg (media/decoder.ts): the TV stills adapter fetches no
 * stream bytes when there is no decoder to turn them into a picture.
 */
const NEEDS_FFMPEG: ReadonlySet<string> = new Set(["tv-stills"]);

/** What on this machine changes a feed's download: its optional keys, and whether ffmpeg is installed. */
export interface Machine {
	readonly hasKey: (key: string) => boolean;
	readonly ffmpeg: boolean;
}

/** A machine with no keys and ffmpeg installed: the figures as measured. */
export const AS_MEASURED: Machine = { hasKey: () => false, ffmpeg: true };

/** MB a day this feed downloads at its default interval on this machine; null: not measured. */
export function dailyMb(id: string, machine: Machine = AS_MEASURED): number | null {
	if (NEEDS_FFMPEG.has(id) && !machine.ffmpeg) return 0;
	const keyed = WITH_KEY[id];
	if (keyed && machine.hasKey(keyed.key)) return keyed.mb;
	return MB_PER_DAY[id] ?? null;
}

/**
 * Whether the data saver turns this feed off (see the threshold above). Decided again on every scheduler tick, so
 * a key added or ffmpeg installed later changes it without a restart.
 */
export function isHeavy(id: string, machine: Machine = AS_MEASURED): boolean {
	return (dailyMb(id, machine) ?? 0) >= HEAVY_MB_PER_DAY;
}

/** The feeds heavy with the figures as measured (no keys, ffmpeg present): the most the data saver turns off. */
export function heavyAsMeasured(): string[] {
	return Object.keys(MB_PER_DAY).filter((id) => isHeavy(id));
}

/** Whether this feed has no measured figure (off by default, needed a key, or its run failed then). */
export function unmeasured(id: string): boolean {
	return UNMEASURED.includes(id);
}

export type SaverSource = "flag" | "setting" | "unset";

export interface SaverState {
	readonly on: boolean;
	/** Who decided: the command line or environment, the user's setting, or nobody yet (off). */
	readonly source: SaverSource;
}

/** The data saver's state: the deployment flag wins over the setting; unset is off. */
export function saverState(flag: boolean | undefined, setting: boolean | undefined): SaverState {
	if (flag !== undefined) return { on: flag, source: "flag" };
	if (setting !== undefined) return { on: setting, source: "setting" };
	return { on: false, source: "unset" };
}

/**
 * Whether a feed is on: the user's switch, else off when the data saver is on and the feed is heavy, else the
 * feed's default for the mode.
 */
export function feedOn(
	adapter: Pick<Adapter, "optIn" | "defaultIn">,
	mode: DeployMode,
	userSwitch: boolean | undefined,
	saverOffHeavy: boolean,
): boolean {
	if (userSwitch !== undefined) return userSwitch;
	if (saverOffHeavy) return false;
	return onByDefault(adapter, mode);
}

export interface Estimate {
	/** MB a day of the feeds that would run (on and not locked), with measured figures. */
	readonly mb: number;
	/** Feeds that would run. */
	readonly feeds: number;
	/** Of those, feeds with no measured figure (not counted in `mb`). */
	readonly unmeasured: number;
}

/** The daily download of a configuration: every feed `runs` says would run, summed from the measured figures. */
export function estimate(
	adapters: readonly Pick<Adapter, "id">[],
	runs: (id: string) => boolean,
	machine: Machine,
): Estimate {
	let mb = 0;
	let feeds = 0;
	let missing = 0;
	for (const a of adapters) {
		if (!runs(a.id)) continue;
		feeds++;
		const d = dailyMb(a.id, machine);
		if (d === null) missing++;
		else mb += d;
	}
	return { mb: Math.round(mb * 10) / 10, feeds, unmeasured: missing };
}
