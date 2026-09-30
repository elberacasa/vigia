import {
	dailyMb,
	estimate,
	HEAVY_MB_PER_DAY,
	isHeavy,
	type Machine,
	MEASURED_AT,
	type SaverState,
	unmeasured,
} from "../core/bandwidth.ts";
import type { Store } from "../core/store.ts";
import type { Adapter } from "../core/types.ts";
import { findDecoder, resetDecoderCache } from "../media/decoder.ts";

/** What the server knows about the data saver (wired in main.ts from settings, keys and the deployment). */
export interface BandwidthDeps {
	readonly state: () => SaverState;
	readonly set: (on: boolean) => void;
	/** Whether this feed would run with the data saver on or off: keys, the deployment and the user's switches. */
	readonly wouldRun: (adapter: Adapter, saverOn: boolean) => boolean;
	/** Keys and ffmpeg on this machine (they change what a feed downloads). */
	readonly machine: () => Machine;
	/** The user's own switch for a feed, if they set one (it wins over the data saver). */
	readonly userSwitch: (id: string) => boolean | undefined;
}

const DAY = 86_400_000;

/** The first-run question is asked only on a person's own Vigía, and only until someone answers it. */
export function saverMeta(state: SaverState, mode: "local" | "public"): { on: boolean; ask: boolean } {
	return { on: state.on, ask: mode === "local" && state.source === "unset" };
}

/**
 * GET /api/data-saver: the setting, the measured figures behind both choices, the heavy feeds and what this machine
 * actually downloaded in the last 24 hours (metered runs only).
 */
export function saverView(
	deps: BandwidthDeps,
	adapters: readonly Adapter[],
	store: Store,
	mode: "local" | "public",
	now: number,
) {
	const state = deps.state();
	const machine = deps.machine();
	const byId = new Map(adapters.map((a) => [a.id, a]));
	const with_ = (on: boolean) =>
		estimate(
			adapters,
			(id) => {
				const a = byId.get(id);
				return a !== undefined && deps.wouldRun(a, on);
			},
			machine,
		);
	const heavy = adapters
		.filter((a) => isHeavy(a.id, machine))
		.map((a) => ({
			id: a.id,
			name: a.name,
			mbPerDay: dailyMb(a.id, machine),
			/** Would run now (the current setting, the user's switch, keys). */
			on: deps.wouldRun(a, state.on),
			/** The user's own switch for it, which wins over the data saver; null: none. */
			override: deps.userSwitch(a.id) ?? null,
		}))
		.sort((a, b) => (b.mbPerDay ?? 0) - (a.mbPerDay ?? 0));
	const since = now - DAY;
	const measured = store.downloadedSince(since);
	let wire = 0;
	let first = now;
	for (const m of measured.values()) {
		wire += m.wire;
		first = Math.min(first, m.first);
	}
	return {
		on: state.on,
		source: state.source,
		ask: saverMeta(state, mode).ask,
		mode,
		threshold: HEAVY_MB_PER_DAY,
		measuredAt: MEASURED_AT,
		heavy,
		estimate: { current: with_(state.on), off: with_(false), on: with_(true) },
		/** This machine, metered: what the feeds downloaded in the window (it may be shorter than a day). */
		downloaded: {
			mb: Math.round((wire / 1_048_576) * 10) / 10,
			feeds: measured.size,
			fromMs: measured.size ? first : null,
			toMs: now,
		},
		unmeasuredOn: adapters.filter((a) => unmeasured(a.id) && deps.wouldRun(a, state.on)).map((a) => a.id),
	};
}

/**
 * GET /api/ffmpeg: whether this computer has the optional ffmpeg the TV stills need (media/decoder.ts), looked up
 * again with `?otra-vez=1` (after installing it; otherwise the answer is cached an hour).
 */
export function ffmpegView(fresh: boolean, env: Record<string, string | undefined> = process.env) {
	if (fresh) resetDecoderCache();
	const decoder = findDecoder(env);
	const setting = env.VIGIA_FFMPEG?.trim();
	return {
		found: decoder !== null,
		version: decoder?.version ?? null,
		/** VIGIA_FFMPEG=0 turned it off on purpose. */
		disabled: setting === "0" || setting === "off",
		/** VIGIA_FFMPEG names a file (it was not found on PATH). */
		fromEnv: Boolean(setting && setting !== "0" && setting !== "off"),
	};
}
