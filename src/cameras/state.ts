import type { StoredObservation } from "../core/store.ts";
import { CAMERA_RULES } from "./rules.ts";
import type { CameraSpec } from "./types.ts";

/**
 * Pure rules over one camera's stored stills: is it live, down or frozen, and (at night) are its city lights dark
 * compared with its own past nights. Deterministic: the same stills and the same `now` give the same answer, so the
 * time machine replays exactly what the room said then. Thresholds: rules.ts.
 */

/** What one round stored for one camera (the `public-cams` adapter's value). */
export type CameraStill = {
	readonly camera: string;
	/** Blob key (GET /api/blobs/public-cams/<key>), or null when this round made no still. */
	readonly blob: string | null;
	readonly width: number | null;
	readonly height: number | null;
	/** Why there is no still: "http-404", "timeout", "not-image", "decode-error", "no-decoder"… */
	readonly reason: string | null;
	/** First 16 hex digits of the SHA-256 of the bytes the operator sent (identical bytes = a frozen picture). */
	readonly sourceSha: string | null;
	/** 64-bit difference hash of the still. */
	readonly hash: string | null;
	readonly lumaMean: number | null;
	readonly lumaSd: number | null;
	/** Mean luma (0–255) of the camera's city-lights region, when it has one and a still was made. */
	readonly lightsMean: number | null;
	/** Share of the lights region brighter than half scale. */
	readonly lightsBright: number | null;
	/** Sun elevation at the camera when the still was taken, degrees (negative: below the horizon). */
	readonly sunDeg: number;
	readonly night: boolean;
	/**
	 * The operator's own time for the picture (its Last-Modified), when it sends one; kept for reference only. The
	 * observation's time is always when Vigía read it: measured 2026-09-29, Bonaire's camera sends a Last-Modified
	 * an hour behind the clock printed on the picture, so a header is not trusted to date or freeze a picture.
	 */
	readonly sourceTime: number | null;
	/** Bytes read for this still, and time taken. */
	readonly bytes: number;
	readonly ms: number;
};

export type CameraState =
	/** A recent still. */
	| "live"
	/** The operator's server keeps sending the same bytes. */
	| "frozen"
	/** No still for several rounds: the camera or its server does not answer. */
	| "down"
	/** Stills stopped arriving because Vigía has not tried recently (feed off or failing), not the camera. */
	| "stale"
	/** Plays only in the operator's player: no still is taken. */
	| "no-stills"
	/** Needs the user's own key (Windy). */
	| "locked"
	/** Never tried. */
	| "unmeasured";

export type StateReading = {
	state: CameraState;
	/** The newest still (with a picture), if any. */
	lastStill: StoredObservation<CameraStill> | null;
	/** The newest attempt, with or without a picture. */
	lastAttempt: StoredObservation<CameraStill> | null;
	/** Since when the state holds (first failed round of a "down", first repeated still of a "frozen"). */
	since: number | null;
	/** The last failure's reason, for "down". */
	detail: string | null;
	/**
	 * When Vigía first saw the newest still's exact bytes (earlier than the newest still when the operator sent the
	 * same picture again): the picture's honest time. Null when there is no still.
	 */
	firstSeenAt: number | null;
};

const liveBudget = (spec: CameraSpec) =>
	CAMERA_RULES.liveCadences * spec.stillEveryMs + CAMERA_RULES.liveSlackMs;

/** Pure: a camera's state at `now` from its attempts, oldest first (only attempts at or before `now` count). */
export function cameraState(
	spec: CameraSpec,
	history: readonly StoredObservation<CameraStill>[],
	now: number,
): StateReading {
	const h = history.filter((o) => o.observedAt <= now);
	const lastAttempt = h.at(-1) ?? null;
	const withStill = h.filter((o) => o.value.blob !== null);
	const lastStill = withStill.at(-1) ?? null;
	// The trailing run of byte-identical stills: the newest picture was first seen at its start.
	let same = 0;
	let firstSame = lastStill;
	if (lastStill?.value.sourceSha)
		for (let i = withStill.length - 1; i >= 0; i--) {
			const o = withStill[i] as StoredObservation<CameraStill>;
			if (o.value.sourceSha !== lastStill.value.sourceSha) break;
			same++;
			firstSame = o;
		}
	const base = { lastStill, lastAttempt, firstSeenAt: firstSame?.observedAt ?? null };
	if (spec.access.type === "embed" || !spec.terms.stills)
		return { ...base, state: "no-stills", since: null, detail: null };
	if (!lastAttempt)
		return {
			...base,
			state: spec.access.type === "windy" ? "locked" : "unmeasured",
			since: null,
			detail: null,
		};
	if (now - lastAttempt.observedAt > liveBudget(spec))
		return { ...base, state: "stale", since: lastAttempt.observedAt, detail: null };

	// Down: the trailing failed attempts.
	let failed = 0;
	for (let i = h.length - 1; i >= 0 && h[i]?.value.blob === null; i--) failed++;
	if (failed > 0) {
		const firstFail = h[h.length - failed] as StoredObservation<CameraStill>;
		if (
			failed >= CAMERA_RULES.downRounds &&
			lastAttempt.observedAt - firstFail.observedAt >= CAMERA_RULES.downMinMs - 1
		)
			return { ...base, state: "down", since: firstFail.observedAt, detail: lastAttempt.value.reason };
		// One or two failures inside the budget: still live on the last still, if it is recent enough.
		if (!lastStill || now - lastStill.observedAt > liveBudget(spec))
			return { ...base, state: "down", since: firstFail.observedAt, detail: lastAttempt.value.reason };
	}

	// Frozen: the trailing stills with byte-identical source.
	if (
		lastStill &&
		firstSame &&
		same >= CAMERA_RULES.frozenStills &&
		lastStill.observedAt - firstSame.observedAt >= CAMERA_RULES.frozenMinMs
	)
		return { ...base, state: "frozen", since: firstSame.observedAt, detail: "same-bytes" };
	// A repeat not yet long enough to call frozen is still live only while its first sighting is recent.
	if (lastStill && firstSame && same >= 2 && now - firstSame.observedAt > liveBudget(spec))
		return { ...base, state: "frozen", since: firstSame.observedAt, detail: "same-bytes" };
	return { ...base, state: "live", since: null, detail: null };
}

export type NightStatus =
	/** The sun is up (or it is twilight) at the camera. */
	| "day"
	/** The camera has no city-lights region. */
	| "no-region"
	/** Not enough past nights at this hour, or lights normally too faint. */
	| "no-baseline"
	| "normal"
	| "dark"
	/** No usable still now (down, frozen, stale). */
	| "unknown";

export type NightReading = {
	status: NightStatus;
	/** The newest night still's lit share of the lights region, its baseline (median share) and their ratio. */
	current: number | null;
	baseline: number | null;
	ratio: number | null;
	/** Distinct past nights in the baseline. */
	nights: number;
	/** The dark run (status "dark"): first and last dark still, how many. */
	darkSince: number | null;
	darkLast: number | null;
	darkStills: number;
	/** The stills behind the reading (for evidence links). */
	refs: { series: string; observedAt: number }[];
};

/** Local mean solar time of day at the camera (ms after local midnight), from its longitude. */
export function solarTimeOfDay(at: number, lon: number): number {
	const day = 86_400_000;
	return (((at + (lon / 15) * 3_600_000) % day) + day) % day;
}

/** The local solar date (a night's evening and morning share one: the date 12 h earlier). */
function nightOf(at: number, lon: number): number {
	return Math.floor((at + (lon / 15) * 3_600_000 - 12 * 3_600_000) / 86_400_000);
}

function median(values: readonly number[]): number {
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Pure: the baseline for a still at `at`: past nights only, same solar hour ± the window. */
export function baselineFor(
	spec: CameraSpec,
	night: readonly StoredObservation<CameraStill>[],
	at: number,
): { value: number | null; nights: number } {
	const r = CAMERA_RULES;
	const tod = solarTimeOfDay(at, spec.lon);
	const tonight = nightOf(at, spec.lon);
	const values: number[] = [];
	const nights = new Set<number>();
	for (const o of night) {
		if (o.observedAt >= at || at - o.observedAt > r.baselineDays * 86_400_000) continue;
		const n = nightOf(o.observedAt, spec.lon);
		if (n === tonight || o.value.lightsBright === null) continue;
		const d = Math.abs(solarTimeOfDay(o.observedAt, spec.lon) - tod);
		if (Math.min(d, 86_400_000 - d) > r.baselineHourWindowMs) continue;
		values.push(o.value.lightsBright);
		nights.add(n);
	}
	return { value: values.length ? median(values) : null, nights: nights.size };
}

/** Pure: the night-brightness reading of a camera at `now` (history oldest first). */
export function nightReading(
	spec: CameraSpec,
	history: readonly StoredObservation<CameraStill>[],
	now: number,
	state: CameraState,
): NightReading {
	const r = CAMERA_RULES;
	const empty = (status: NightStatus, extra: Partial<NightReading> = {}): NightReading => ({
		status,
		current: null,
		baseline: null,
		ratio: null,
		nights: 0,
		darkSince: null,
		darkLast: null,
		darkStills: 0,
		refs: [],
		...extra,
	});
	if (!spec.lights) return empty("no-region");
	const h = history.filter((o) => o.observedAt <= now);
	const newestStill = h.filter((o) => o.value.blob !== null).at(-1);
	if (!newestStill || state !== "live")
		return empty(newestStill && !newestStill.value.night ? "day" : "unknown");
	if (!newestStill.value.night || newestStill.value.lightsBright === null) return empty("day");
	// Usable night stills: a picture and a lights value, not a repeat of the previous bytes.
	const night: StoredObservation<CameraStill>[] = [];
	for (const o of h) {
		if (o.value.blob === null || !o.value.night || o.value.lightsBright === null) continue;
		if (night.at(-1)?.value.sourceSha === o.value.sourceSha && o.value.sourceSha !== null) continue;
		night.push(o);
	}
	// The reading is of the newest distinct picture (a byte repeat is the same picture, not a new one).
	const last = night.at(-1);
	if (!last) return empty("unknown");
	const judge = (o: StoredObservation<CameraStill>) => {
		const b = baselineFor(spec, night, o.observedAt);
		const ok = b.value !== null && b.nights >= r.minBaselineNights && b.value >= r.minBaselineShare;
		return { b, ratio: ok && b.value ? (o.value.lightsBright ?? 0) / b.value : null };
	};
	const now_ = judge(last);
	const current = {
		current: last.value.lightsBright,
		baseline: now_.b.value,
		nights: now_.b.nights,
		ratio: now_.ratio === null ? null : Math.round(now_.ratio * 1000) / 1000,
	};
	if (now_.ratio === null) return empty("no-baseline", current);
	// The trailing run of dark night stills (tonight only), newest backwards.
	const run: StoredObservation<CameraStill>[] = [];
	const tonight = nightOf(last.observedAt, spec.lon);
	for (let i = night.length - 1; i >= 0; i--) {
		const o = night[i] as StoredObservation<CameraStill>;
		if (nightOf(o.observedAt, spec.lon) !== tonight) break;
		const j = judge(o);
		if (j.ratio === null || j.ratio > r.darkRatio) break;
		run.unshift(o);
	}
	const first = run[0];
	const dark =
		run.length >= r.darkStills &&
		first !== undefined &&
		last.observedAt - first.observedAt >= r.darkMinSpanMs &&
		run.at(-1) === last;
	if (!dark) return { ...empty("normal"), ...current };
	return {
		status: "dark",
		...current,
		darkSince: first.observedAt,
		darkLast: last.observedAt,
		darkStills: run.length,
		refs: run.map((o) => ({ series: o.series, observedAt: o.observedAt })),
	};
}
