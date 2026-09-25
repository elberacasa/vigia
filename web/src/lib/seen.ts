import { signal } from "@preact/signals";

/**
 * "Nuevo" markers driven only by data arrival. Each list (a "scope": news, quakes, outage events, the ticker)
 * reports the ids it currently holds; an id this device has never shown before is fresh for FRESH_MS, then it is
 * an ordinary row. The ids already shown are kept per device, so a reload does not re-announce everything, and
 * the first time a device sees a list nothing is new (it is all new, so none of it is news).
 *
 * Use it from a panel:
 *   const fresh = useFresh("quakes", rows.map((r) => r.id));
 *   <li class={fresh.has(r.id) ? "is-new" : ""}>{fresh.has(r.id) ? <NewTag /> : null}…</li>
 * (NewTag is in ui/Digits.tsx; the .is-new row style in styles/live.css.)
 */

export const FRESH_MS = 20_000;
/**
 * A row whose own time (a quake's origin, a story's first headline) is older than this is never "nuevo", even the
 * first time this device sees it: a reader back after a day would otherwise see 48-hour-old items marked new.
 */
export const NEW_MAX_AGE_MS = 60 * 60_000;
const KEY = "vigia:seen:v1";
/** Per scope, enough memory for every id a panel lists (news holds ~200 stories over 48 h). */
const KEEP = 600;

type Store = Record<string, string[]>;

export interface SeenStorage {
	load(): Store;
	save(store: Store): void;
}

const localStore: SeenStorage = {
	load() {
		try {
			const raw = localStorage.getItem(KEY);
			return raw ? (JSON.parse(raw) as Store) : {};
		} catch {
			return {};
		}
	},
	save(store) {
		try {
			localStorage.setItem(KEY, JSON.stringify(store));
		} catch {
			// Storage full or disabled: rows are then only "new" within this visit, which is still true.
		}
	},
};

/** Deterministic core, separate from storage and timers so it is testable. */
export class Arrivals {
	private store: Store;
	private seen = new Map<string, Set<string>>();
	private arrivedAt = new Map<string, number>();
	private lastKey = new Map<string, string>();

	constructor(private readonly storage: SeenStorage) {
		this.store = storage.load();
	}

	/**
	 * Records the ids a scope holds now; returns those that arrived within FRESH_MS of `at`. `timeOf` gives a row's
	 * own time when it has one; rows older than NEW_MAX_AGE_MS are remembered but never marked.
	 */
	observe(
		scope: string,
		ids: readonly string[],
		at: number,
		timeOf?: (id: string) => number | null | undefined,
	): Set<string> {
		// A list that has not loaded yet is not an observation (else everything would be "new" once it loads).
		if (!ids.length) return new Set();
		const key = ids.join("\u0001");
		if (this.lastKey.get(scope) !== key) {
			this.lastKey.set(scope, key);
			let known = this.seen.get(scope);
			const first = !known && !this.store[scope];
			if (!known) {
				known = new Set(this.store[scope] ?? []);
				this.seen.set(scope, known);
			}
			let added = false;
			for (const id of ids) {
				if (known.has(id)) continue;
				known.add(id);
				added = true;
				const own = timeOf?.(id);
				const old = own !== null && own !== undefined && at - own > NEW_MAX_AGE_MS;
				if (!first && !old) this.arrivedAt.set(`${scope}\u0000${id}`, at);
			}
			if (added || first) {
				// Current ids first, so trimming drops the ones that left the list longest ago.
				const current = new Set(ids);
				const rest = [...known].filter((id) => !current.has(id));
				this.store[scope] = [...current, ...rest.slice(-(KEEP - current.size))].slice(0, KEEP);
				this.storage.save(this.store);
			}
		}
		const fresh = new Set<string>();
		for (const id of ids) {
			const t = this.arrivedAt.get(`${scope}\u0000${id}`);
			if (t !== undefined && at - t < FRESH_MS) fresh.add(id);
		}
		return fresh;
	}

	/** Earliest moment one of the current fresh ids stops being fresh, or null. */
	nextExpiry(at: number): number | null {
		let next: number | null = null;
		for (const t of this.arrivedAt.values()) {
			const end = t + FRESH_MS;
			if (end > at && (next === null || end < next)) next = end;
		}
		return next;
	}
}

let arrivals: Arrivals | null = null;
/** Bumped when a fresh window ends, so rows drop their marker without per-frame work. */
const tick = signal(0);
const counts = signal<Record<string, number>>({});
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
	if (timer || !arrivals) return;
	const next = arrivals.nextExpiry(Date.now());
	if (next === null) return;
	timer = setTimeout(
		() => {
			timer = null;
			tick.value++;
			schedule();
		},
		next - Date.now() + 50,
	);
}

/**
 * The ids of `ids` that arrived in the last FRESH_MS on this device. Call it in render; it only does work when
 * the list itself changes. Arrival uses the device clock (it is about what the reader saw, not about the data).
 */
export function useFresh(
	scope: string,
	ids: readonly string[],
	timeOf?: (id: string) => number | null | undefined,
): Set<string> {
	void tick.value;
	arrivals ??= new Arrivals(localStore);
	const fresh = arrivals.observe(scope, ids, Date.now(), timeOf);
	if ((counts.peek()[scope] ?? 0) !== fresh.size) {
		// Deferred: writing a signal during another component's render would re-render mid-pass.
		queueMicrotask(() => {
			counts.value = { ...counts.value, [scope]: fresh.size };
		});
	}
	if (fresh.size) schedule();
	return fresh;
}

/** How many rows of a scope are fresh right now, e.g. for an "N nuevos" pill (read in render: it subscribes). */
export function freshCount(scope: string): number {
	return counts.value[scope] ?? 0;
}
