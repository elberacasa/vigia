/**
 * Crowd reports: taking a report (validated, rate-limited, proof of work, flood rules, one answer per connection),
 * counting it in its 15-minute bucket, and publishing the aggregates as observations of the Vigía-own source
 * "vigia-crowd" (per municipality and per state, only above the minimum of distinct reporters), which the panel,
 * the entity pages and the incidents read like any other source. No model: counts and stated thresholds.
 */

import type { Store } from "../core/store.ts";
import type { Json, Observation } from "../core/types.ts";
import { populationOf } from "../ontology/population.ts";
import { registry as defaultRegistry, type Registry } from "../ontology/registry.ts";
import type { Entity } from "../ontology/types.ts";
import { Challenges } from "./challenge.ts";
import { bucketOf, CrowdCounts, type Status, setInstanceMode } from "./counts.ts";
import { ClientMemory, DEVICE_TOKEN } from "./memory.ts";
import {
	ANSWER_TEXT,
	ANSWERS,
	type Answer,
	CROWD_LICENCE,
	CROWD_RULES,
	CROWD_SOURCE,
	type CrowdMode,
	crowdRulesText,
	SERVICE_TEXT,
	SERVICES,
	type Service,
	storedText,
} from "./rules.ts";

const MIN = 60_000;
const DAY = 86_400_000;

/** What a published aggregate says (the value of a "vigia-crowd" observation). */
export type CrowdAggregate = {
	level: "municipality" | "state";
	entity: string;
	/** ISO 3166-2 code of the state. */
	state: string;
	service: Service;
	/** false: a tombstone, the pair has nothing to show any more. */
	shown: boolean;
	/** Counted reports (one per reporter: an address, or a phone behind it with its token; a state sums its shown municipalities). */
	reports: number | null;
	/** Of those, distinct connections (addresses): phones behind one address count once here. */
	connections: number;
	answers: Record<Answer, number> | null;
	/** Reports beyond the flood ceiling: "posible manipulación", never counted. */
	held: number;
	/** The held reports by answer (a flood of «sí» is not a flood of «no»). */
	heldAnswers: Record<Answer, number>;
	flagged: boolean;
	/** Always false: a pair below the minimum is never published (kept for the shape of older rows). */
	belowMinimum: boolean;
	/** State level: municipalities shown (at or above the minimum) that the sum adds up; municipality level: 1. */
	municipalities: number;
	/** Answers "no" and "intermitente": how many, from how many connections, first and last bucket; null without any. */
	outage: { count: number; connections: number; firstAt: number; lastAt: number } | null;
	windowFrom: number;
	windowTo: number;
	windowMs: number;
	minReporters: number;
	/** Distinct connections a figure needs besides `minReporters`. */
	minConnections: number;
	/** Outage answers a municipality needs (none held) for its reports to be incident evidence… */
	incidentMin: number;
	/** …from at least this many connections. */
	incidentMinConnections: number;
	mode: CrowdMode;
};

export type ReportResult = {
	service: Service;
	answer: Answer;
	/**
	 * "counted", "held" (beyond the flood ceiling), "updated" (replaced this reporter's earlier answer), or "capped"
	 * (its address already has `devicesPerPair` live reporters there: not counted). The page is only ever told
	 * "received".
	 */
	status: "counted" | "held" | "updated" | "capped";
};

export type SubmitOutcome =
	| {
			ok: true;
			municipality: { id: string; name: string; state: string };
			results: ReportResult[];
			/** When the counts including this report are published (a public mirror waits for the bucket to close). */
			publishedFrom: number;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 429 | 503;
			code: "off" | "invalid" | "pow" | "rate" | "municipalities" | "busy";
			error: string;
			retryAfter?: number;
	  };

export interface CrowdOptions {
	readonly store: Store;
	readonly mode: CrowdMode;
	/** The per-instance switch (VIGIA_CROWD). Off: nothing is taken, the existing archive stays readable. */
	readonly enabled: boolean;
	readonly now?: () => number;
	readonly registry?: Registry;
	/** Called after aggregates were archived (the app invalidates panels, links new rows, tells open pages). */
	readonly onInserted?: (inserted: number) => void;
	/** Tests only: the proof of work's base difficulty instead of the mode's (so a test does not burn CPU). */
	readonly powBits?: number;
	/** Serving the local network (`--host 0.0.0.0`): a personal Vigía then publishes closed buckets only. */
	readonly lan?: boolean;
	/** Whether an address is one of the declared reverse proxies (a report "from" one means its client is unknown). */
	readonly trustedProxy?: (ip: string) => boolean;
}

const REFUSE = {
	off: "Los reportes de usuarios están desactivados en este Vigía.",
	invalid: "Reporte no válido.",
	pow: "La prueba de trabajo no es válida o venció. Pide un desafío nuevo.",
	rate: "Demasiados reportes desde esta conexión. Espera un poco.",
	municipalities: `Desde esta conexión ya se reportaron ${CROWD_RULES.perClient.maxMunicipalitiesPerDay} municipios hoy.`,
	busy: "Vigía recibe demasiados reportes en este momento. Intenta en un minuto.",
} as const;

const emptyAnswers = (): Record<Answer, number> => ({ si: 0, no: 0, intermitente: 0 });

export class CrowdService {
	readonly mode: CrowdMode;
	readonly enabled: boolean;
	readonly counts: CrowdCounts;
	readonly memory: ClientMemory;
	readonly challenges: Challenges;
	readonly #store: Store;
	readonly #now: () => number;
	readonly #registry: Registry;
	readonly #onInserted: (n: number) => void;
	readonly #powBits: number;
	/** Whether this instance publishes the open bucket (a personal Vigía on this machine only). */
	readonly openBucket: boolean;
	readonly trustedProxy: (ip: string) => boolean;
	/** New reports per minute, per state ("VE-V|<minute>") and in all ("*|<minute>"): the load limits. */
	readonly #perMinute = new Map<string, number>();
	/** New reports per bucket in all (the difficulty of the next bucket). */
	readonly #perBucket = new Map<number, number>();
	/** Ceilings per municipality, service and day (the history query runs once a day per pair). */
	readonly #ceilings = new Map<string, number>();
	/** The last value published per pair (without its window), to publish changes and tombstones. */
	#published: Map<string, { value: string; at: number; shown: boolean }> | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#debounce: ReturnType<typeof setTimeout> | null = null;
	#lastPrune = 0;

	constructor(options: CrowdOptions) {
		this.#store = options.store;
		this.mode = options.mode;
		this.enabled = options.enabled;
		this.#now = options.now ?? Date.now;
		this.#registry = options.registry ?? defaultRegistry();
		this.#onInserted = options.onInserted ?? (() => {});
		this.#powBits = options.powBits ?? CROWD_RULES.pow.difficulty[options.mode];
		this.openBucket = CROWD_RULES.publishOpenBucket[options.mode] && !options.lan;
		this.trustedProxy = options.trustedProxy ?? (() => false);
		this.counts = new CrowdCounts(options.store);
		setInstanceMode(options.store, options.mode);
		this.challenges = new Challenges(this.#now);
		this.memory = new ClientMemory(this.#now);
		this.memory.onRotate = () => {
			this.challenges.rotate();
			this.#ceilings.clear();
		};
	}

	/**
	 * The proof-of-work difficulty: the mode's, harder for a whole bucket after a bucket that averaged more than
	 * `loadPerMinute` new reports a minute. Fixed within a bucket, so it tells nobody when one report arrived.
	 */
	difficulty(): number {
		const b = CROWD_RULES.bucketMs;
		const previous = this.#perBucket.get(bucketOf(this.#now()) - b) ?? 0;
		const busy = previous / (b / MIN) > CROWD_RULES.pow.loadPerMinute;
		return busy ? this.#powBits + CROWD_RULES.pow.underLoadExtra : this.#powBits;
	}

	/** GET /api/crowd: what the page needs to ask, and the rules in words. */
	info(): Json {
		const min = CROWD_RULES.minReporters[this.mode];
		return {
			enabled: this.enabled,
			mode: this.mode,
			services: SERVICES.map((s) => ({
				id: s,
				es: SERVICE_TEXT[s].es,
				en: SERVICE_TEXT[s].en,
				question: { ...SERVICE_TEXT[s].question },
			})),
			answers: ANSWERS.map((a) => ({ id: a, ...ANSWER_TEXT[a] })),
			windowMs: CROWD_RULES.windowMs,
			bucketMs: CROWD_RULES.bucketMs,
			minReporters: min,
			publishOpenBucket: this.openBucket,
			limits: {
				burst: CROWD_RULES.perClient.burst,
				perHour: CROWD_RULES.perClient.perHour,
				maxMunicipalitiesPerDay: CROWD_RULES.perClient.maxMunicipalitiesPerDay,
			},
			pow: {
				algorithm: "sha256-leading-zero-bits",
				input: "challenge + ':' + nonce (ASCII); nonce: base-36 counter, 1–16 characters",
				difficulty: this.difficulty(),
				challenge: "/api/crowd/challenge",
			},
			submit: "/api/crowd/reports",
			source: {
				id: CROWD_SOURCE,
				licence: CROWD_LICENCE.id,
				licenceName: CROWD_LICENCE.name,
				licenceUrl: CROWD_LICENCE.url,
				attribution: CROWD_LICENCE.attribution,
			},
			rules: crowdRulesText(this.mode),
			incident: {
				minOutageReports: CROWD_RULES.incident.minOutageReports[this.mode],
				services: Object.keys(CROWD_RULES.incident.speaks),
			},
			stored: storedText(),
		};
	}

	/** GET /api/crowd/challenge. */
	challenge(ip: string): { ok: true; challenge: Json } | Extract<SubmitOutcome, { ok: false }> {
		if (!this.enabled) return { ok: false, status: 404, code: "off", error: REFUSE.off };
		const fp = this.memory.fingerprint(ip);
		if (!this.memory.takeChallenge(fp))
			return { ok: false, status: 429, code: "rate", error: REFUSE.rate, retryAfter: 60 };
		const c = this.challenges.issue(this.difficulty());
		return { ok: true, challenge: { ...c, algorithm: "sha256-leading-zero-bits" } };
	}

	/**
	 * POST /api/crowd/reports, after the app's write guard: `{municipality, answers: {luz: "no", …}, challenge, nonce,
	 * token?}`. A reporter is the address and, when sent, the page's per-device token.
	 */
	submit(body: unknown, ip: string): SubmitOutcome {
		if (!this.enabled) return { ok: false, status: 404, code: "off", error: REFUSE.off };
		const parsed = parseReport(body, this.#registry);
		if (!parsed) return { ok: false, status: 400, code: "invalid", error: REFUSE.invalid };
		const { muni, answers, challenge, nonce, token } = parsed;
		const fp = this.memory.fingerprint(ip);
		const mine = this.memory.municipalities(fp);
		if (!mine.has(muni.id) && mine.size >= CROWD_RULES.perClient.maxMunicipalitiesPerDay)
			return {
				ok: false,
				status: 429,
				code: "municipalities",
				error: REFUSE.municipalities,
				retryAfter: 3_600,
			};
		const now = this.#now();
		const bucket = bucketOf(now);
		const iso = this.#registry.ancestors(muni.id).find((a) => a.type === "state")?.codes.iso ?? "";
		const cap = CROWD_RULES.perClient.devicesPerPair;
		// Per answer: this reporter's live entry, or how many other reporters its address already has there.
		const plan = answers.map(([service]) => {
			const old = this.memory.entry(ip, fp, token, muni.id, service);
			const others = old ? 0 : this.memory.reporters(ip, fp, muni.id, service);
			return { old, capped: !old && others >= cap, extra: !old && others > 0 };
		});
		const fresh = plan.filter((p) => !p.old && !p.capped).length;
		// Cheap checks first: the load limits, before a challenge is spent; the proof of work, before a token is taken
		// (so invalid work cannot drain the limits of everyone behind a shared address).
		if (fresh > 0 && !this.#loadAllows(iso, fresh, now))
			return { ok: false, status: 503, code: "busy", error: REFUSE.busy, retryAfter: 60 };
		const pow = this.challenges.redeem(challenge, nonce);
		if (!pow.ok) return { ok: false, status: 403, code: "pow", error: REFUSE.pow };
		if (!this.memory.takeSubmit(fp, ip))
			return { ok: false, status: 429, code: "rate", error: REFUSE.rate, retryAfter: 180 };
		const results: ReportResult[] = [];
		const device = this.memory.device(token);
		answers.forEach(([service, answer], i) => {
			const { old = null, capped = false, extra = false } = plan[i] ?? {};
			if (capped) {
				// Its address already has as many live reporters here as a carrier NAT plausibly holds: not counted.
				results.push({ service, answer, status: "capped" });
				return;
			}
			if (old && old.answer === answer) {
				// The same answer again: it moves to now, keeps its status, and is not a new arrival.
				this.counts.add(muni.id, service, old.bucket, old.answer, old.status, -1, old.extra);
				this.counts.add(muni.id, service, bucket, answer, old.status, 1, old.extra);
				old.bucket = bucket;
				this.memory.remember(fp, old);
				results.push({ service, answer, status: "updated" });
				return;
			}
			// A new report, or a changed answer: it arrives for its answer, under that answer's ceiling.
			if (old) this.counts.add(muni.id, service, old.bucket, old.answer, old.status, -1, old.extra);
			const status: Status = this.#overCeiling(muni, service, answer, now) ? "held" : "counted";
			const isExtra = old ? old.extra : extra;
			this.counts.add(muni.id, service, bucket, answer, status, 1, isExtra);
			this.counts.arrive(muni.id, service, answer, bucket);
			if (old) {
				old.bucket = bucket;
				old.answer = answer;
				old.status = status;
				this.memory.remember(fp, old);
				results.push({ service, answer, status: "updated" });
				return;
			}
			this.memory.remember(fp, { entity: muni.id, service, bucket, answer, status, device, extra });
			this.#countLoad(iso, now);
			results.push({ service, answer, status });
		});
		if (this.openBucket) this.#schedule();
		return {
			ok: true,
			municipality: { id: muni.id, name: muni.name.es, state: iso },
			results,
			publishedFrom: this.openBucket ? now : bucket + CROWD_RULES.bucketMs,
		};
	}

	/** The flood ceiling for a municipality and service (reports per `flood.windowMs`). */
	ceiling(muni: Entity, service: Service, now: number): number {
		const key = `${muni.id}|${service}|${Math.floor(now / DAY)}`;
		const hit = this.#ceilings.get(key);
		if (hit !== undefined) return hit;
		const f = CROWD_RULES.flood;
		const pop = populationOf(this.#registry, muni);
		const people = pop?.worldpop2026?.people ?? pop?.census2011?.people ?? 0;
		const value = Math.max(
			f.floorPerHour,
			Math.ceil(f.historyMultiplier * this.counts.usualPeak(muni.id, service, now)),
			Math.floor(people / f.inhabitantsPerReport),
		);
		this.#ceilings.set(key, value);
		return value;
	}

	/** Whether one more new report of this answer would pass its ceiling (new reports in the last hour). */
	#overCeiling(muni: Entity, service: Service, answer: Answer, now: number): boolean {
		const from = bucketOf(now) - (CROWD_RULES.flood.windowMs - CROWD_RULES.bucketMs);
		return this.counts.arrivalsSince(muni.id, service, answer, from) + 1 > this.ceiling(muni, service, now);
	}

	#countLoad(iso: string, now: number): void {
		const minute = Math.floor(now / MIN);
		for (const k of [`${iso}|${minute}`, `*|${minute}`])
			this.#perMinute.set(k, (this.#perMinute.get(k) ?? 0) + 1);
		const bucket = bucketOf(now);
		this.#perBucket.set(bucket, (this.#perBucket.get(bucket) ?? 0) + 1);
		if (this.#perMinute.size > 200)
			for (const k of this.#perMinute.keys())
				if (Number(k.split("|")[1]) < minute - 1) this.#perMinute.delete(k);
		for (const b of this.#perBucket.keys()) if (b < bucket - CROWD_RULES.bucketMs) this.#perBucket.delete(b);
	}

	/** New reports in the last minute for a key: this minute plus the unexpired share of the previous one. */
	#recentLoad(key: string, now: number): number {
		const minute = Math.floor(now / MIN);
		const frac = (now % MIN) / MIN;
		return (
			(this.#perMinute.get(`${key}|${minute}`) ?? 0) +
			(this.#perMinute.get(`${key}|${minute - 1}`) ?? 0) * (1 - frac)
		);
	}

	#loadAllows(iso: string, n: number, now: number): boolean {
		const l = CROWD_RULES.load;
		return (
			this.#recentLoad(iso, now) + n <= l.perStatePerMinute &&
			this.#recentLoad("*", now) + n <= l.globalPerMinute
		);
	}

	// ——— publishing ———

	/**
	 * The aggregates of the window ending now (up to the last closed bucket unless this instance publishes the open
	 * one), per municipality and state. Nothing below the minimum is ever published, not even a flag, and a state sums
	 * only its municipalities that are shown, so no hidden report can be read off by subtraction.
	 */
	aggregates(now: number = this.#now()): CrowdAggregate[] {
		const b = CROWD_RULES.bucketMs;
		const open = this.openBucket;
		const to = bucketOf(now) + (open ? b : 0);
		const from = to - CROWD_RULES.windowMs;
		const end = open ? Math.min(now, to) : to;
		const min = CROWD_RULES.minReporters[this.mode];
		const minConnections = CROWD_RULES.minConnections[this.mode];
		const incidentMin = CROWD_RULES.incident.minOutageReports[this.mode];
		const incidentMinConnections = CROWD_RULES.incident.minOutageConnections[this.mode];
		type Acc = {
			entity: string;
			state: string;
			stateId: string;
			service: Service;
			answers: Record<Answer, number>;
			held: Record<Answer, number>;
			extra: Record<Answer, number>;
			munis: number;
			outFirst: number;
			outLast: number;
		};
		const fresh = (entity: string, state: string, stateId: string, service: Service): Acc => ({
			entity,
			state,
			stateId,
			service,
			answers: emptyAnswers(),
			held: emptyAnswers(),
			extra: emptyAnswers(),
			munis: 0,
			outFirst: Number.POSITIVE_INFINITY,
			outLast: Number.NEGATIVE_INFINITY,
		});
		const munis = new Map<string, Acc>();
		const stateOf = new Map<string, Entity | null>();
		for (const r of this.counts.window(from, to)) {
			if (
				!(SERVICES as readonly string[]).includes(r.service) ||
				!(ANSWERS as readonly string[]).includes(r.answer)
			)
				continue;
			if (!stateOf.has(r.entity))
				stateOf.set(r.entity, this.#registry.ancestors(r.entity).find((x) => x.type === "state") ?? null);
			const st = stateOf.get(r.entity);
			const iso = st?.codes.iso;
			if (!st || !iso) continue;
			const k = `${r.entity}|${r.service}`;
			const a = munis.get(k) ?? fresh(r.entity, iso, st.id, r.service);
			munis.set(k, a);
			a.answers[r.answer] += r.counted;
			a.held[r.answer] += r.held;
			a.extra[r.answer] += Math.min(r.extra, r.counted);
			if (r.answer !== "si" && r.firstCounted !== null && r.lastCounted !== null) {
				a.outFirst = Math.min(a.outFirst, r.firstCounted);
				a.outLast = Math.max(a.outLast, r.lastCounted + b);
			}
		}
		const total = (x: Record<Answer, number>) => x.si + x.no + x.intermitente;
		const connectionsOf = (a: Acc) => total(a.answers) - total(a.extra);
		const shown = [...munis.values()].filter(
			(a) => total(a.answers) >= min && connectionsOf(a) >= minConnections,
		);
		const states = new Map<string, Acc>();
		for (const m of shown) {
			const k = `${m.stateId}|${m.service}`;
			const s = states.get(k) ?? fresh(m.stateId, m.state, m.stateId, m.service);
			states.set(k, s);
			for (const ans of ANSWERS) {
				s.answers[ans] += m.answers[ans];
				s.held[ans] += m.held[ans];
				s.extra[ans] += m.extra[ans];
			}
			s.munis++;
			s.outFirst = Math.min(s.outFirst, m.outFirst);
			s.outLast = Math.max(s.outLast, m.outLast);
		}
		const out: CrowdAggregate[] = [];
		const emit = (level: CrowdAggregate["level"], a: Acc) => {
			const outage = a.answers.no + a.answers.intermitente;
			// Conservative: a report marked extra is not another connection even if its answer differs.
			const outageConnections = outage - a.extra.no - a.extra.intermitente;
			const held = total(a.held);
			out.push({
				level,
				entity: a.entity,
				state: a.state,
				service: a.service,
				shown: true,
				reports: total(a.answers),
				connections: connectionsOf(a),
				answers: { ...a.answers },
				held,
				heldAnswers: { ...a.held },
				flagged: held > 0,
				belowMinimum: false,
				municipalities: level === "state" ? a.munis : 1,
				outage:
					outage > 0 && Number.isFinite(a.outFirst)
						? {
								count: outage,
								connections: outageConnections,
								firstAt: a.outFirst,
								lastAt: Math.min(a.outLast, end),
							}
						: null,
				windowFrom: from,
				windowTo: end,
				windowMs: CROWD_RULES.windowMs,
				minReporters: min,
				minConnections,
				incidentMin,
				incidentMinConnections,
				mode: this.mode,
			});
		};
		for (const m of shown) emit("municipality", m);
		for (const st of states.values()) emit("state", st);
		return out.sort(
			(x, y) =>
				x.level.localeCompare(y.level) ||
				x.entity.localeCompare(y.entity) ||
				x.service.localeCompare(y.service),
		);
	}

	/**
	 * Archives the aggregates: every shown pair at each bucket boundary (so a figure's age says the publisher is
	 * alive), a changed pair at once when the open bucket is published (a person's own Vigía), and a tombstone for a
	 * pair that had something and has nothing now. Returns the rows inserted.
	 */
	snapshot(now: number = this.#now()): number {
		// Closed buckets' counts are written now, together, in key order (never report by report).
		this.counts.flush(now);
		const boundary = bucketOf(now);
		// Dated by the bucket, never by the moment of a report: a personal Vigía's own publication included.
		const observedAt = boundary;
		const fetchedAt = this.openBucket ? boundary : now;
		const published = this.#publishedMap(now);
		const rows: Observation[] = [];
		const seen = new Set<string>();
		for (const a of this.aggregates(now)) {
			const pair = pairKey(a.level, a.entity, a.service);
			seen.add(pair);
			const { windowFrom: _f, windowTo: _t, ...stable } = a;
			const value = JSON.stringify(stable);
			const last = published.get(pair);
			// Unchanged within the same bucket: nothing new to say.
			if (last?.shown && last.value === value && last.at >= boundary) continue;
			rows.push(aggregateObservation(a, observedAt, fetchedAt));
			published.set(pair, { value, at: observedAt, shown: true });
		}
		for (const [pair, last] of published) {
			if (seen.has(pair) || !last.shown) continue;
			const [level, entity, service] = pair.split("|") as [CrowdAggregate["level"], string, Service];
			rows.push(tombstone(level, entity, service, observedAt, fetchedAt, this.mode));
			published.set(pair, { value: "", at: observedAt, shown: false });
		}
		const inserted = rows.length ? this.#store.insert(rows) : 0;
		if (inserted > 0) this.#onInserted(inserted);
		if (now - this.#lastPrune > DAY) {
			this.#lastPrune = now;
			this.counts.prune(now - CROWD_RULES.retentionDays * DAY, now);
		}
		this.memory.sweep();
		return inserted;
	}

	/** What was last published per pair, read back from the archive after a restart. */
	#publishedMap(now: number): Map<string, { value: string; at: number; shown: boolean }> {
		if (this.#published) return this.#published;
		const map = new Map<string, { value: string; at: number; shown: boolean }>();
		const since = now - CROWD_RULES.windowMs - CROWD_RULES.staleAfterMs;
		const newest = new Map<string, { at: number; a: CrowdAggregate }>();
		for (const o of this.#store.latestPerSeries(CROWD_SOURCE, since, 20_000)) {
			const a = o.value as unknown as CrowdAggregate;
			if (!a || typeof a !== "object" || typeof a.entity !== "string") continue;
			const pair = pairKey(a.level, a.entity, a.service);
			const prev = newest.get(pair);
			if (!prev || o.observedAt > prev.at) newest.set(pair, { at: o.observedAt, a });
		}
		for (const [pair, { at, a }] of newest) {
			const { windowFrom: _f, windowTo: _t, ...stable } = a;
			map.set(pair, { value: a.shown ? JSON.stringify(stable) : "", at, shown: a.shown });
		}
		this.#published = map;
		return map;
	}

	#schedule(): void {
		if (this.#debounce) return;
		this.#debounce = setTimeout(() => {
			this.#debounce = null;
			this.#safeSnapshot();
		}, 5_000);
		this.#debounce.unref?.();
	}

	#safeSnapshot(): void {
		try {
			this.snapshot();
		} catch (error) {
			console.error("[vigia] reportes:", error instanceof Error ? error.message : error);
		}
	}

	/** Publishes now, then at every bucket boundary (a couple of seconds after it, so the closed bucket is complete). */
	start(): void {
		if (this.#timer) return;
		this.#safeSnapshot();
		const next = () => {
			const b = CROWD_RULES.bucketMs;
			const wait = b - (this.#now() % b) + 2_000;
			this.#timer = setTimeout(() => {
				this.#safeSnapshot();
				next();
			}, wait);
			this.#timer.unref?.();
		};
		next();
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#debounce) clearTimeout(this.#debounce);
		this.#timer = null;
		this.#debounce = null;
	}
}

const pairKey = (level: string, entity: string, service: string) => `${level}|${entity}|${service}`;

/** The hour a published aggregate belongs to (its timeline series): "2026-09-28T14". */
export const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13);

export function aggregateObservation(a: CrowdAggregate, observedAt: number, fetchedAt: number): Observation {
	return {
		source: CROWD_SOURCE,
		series: `${a.level === "state" ? "state" : "muni"}:${a.entity}:${a.service}:${hourKey(observedAt)}`,
		sourceUrl: `/api/v1/entities/${a.entity}`,
		fetchedAt,
		observedAt,
		licence: CROWD_LICENCE.id,
		value: a as unknown as Json,
		confidence: 1,
		basis: "report",
	};
}

function tombstone(
	level: CrowdAggregate["level"],
	entity: string,
	service: Service,
	observedAt: number,
	fetchedAt: number,
	mode: CrowdMode,
): Observation {
	const value = {
		level,
		entity,
		service,
		shown: false,
		mode,
		windowMs: CROWD_RULES.windowMs,
	};
	return {
		source: CROWD_SOURCE,
		series: `${level === "state" ? "state" : "muni"}:${entity}:${service}:fin`,
		sourceUrl: `/api/v1/entities/${entity}`,
		fetchedAt,
		observedAt,
		licence: CROWD_LICENCE.id,
		value,
		confidence: 1,
		basis: "report",
	};
}

type Parsed = {
	muni: Entity;
	answers: [Service, Answer][];
	challenge: unknown;
	nonce: unknown;
	/** The page's per-device token (16 random bytes, base64url), or null when not sent. */
	token: string | null;
};

/**
 * Validates a report body strictly: known keys only, a municipality of the registry (by id or P-code), 1–4 known
 * services with known answers.
 */
export function parseReport(body: unknown, reg: Registry): Parsed | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	const allowed = new Set(["municipality", "answers", "challenge", "nonce", "token"]);
	if (Object.keys(b).some((k) => !allowed.has(k))) return null;
	if (b.token !== undefined && (typeof b.token !== "string" || !DEVICE_TOKEN.test(b.token))) return null;
	if (typeof b.municipality !== "string" || b.municipality.length > 120) return null;
	// An entity id ("ve.zulia.maracaibo") or the municipality's P-code ("VE2313", what the page's place index carries).
	const muni = /^VE\d{4}$/.test(b.municipality)
		? reg.byCode(`pcode:${b.municipality}`)
		: reg.get(b.municipality);
	if (muni?.type !== "municipality") return null;
	const raw = b.answers;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length < 1 || entries.length > SERVICES.length) return null;
	const answers: [Service, Answer][] = [];
	for (const [k, v] of entries) {
		if (!(SERVICES as readonly string[]).includes(k) || !(ANSWERS as readonly unknown[]).includes(v))
			return null;
		answers.push([k as Service, v as Answer]);
	}
	return {
		muni,
		answers,
		challenge: b.challenge,
		nonce: b.nonce,
		token: typeof b.token === "string" ? b.token : null,
	};
}
