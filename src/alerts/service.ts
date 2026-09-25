import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FeedHealth } from "../core/health.ts";
import {
	type CensorshipIn,
	type ConnectivityIn,
	emptyMemory,
	evaluate,
	type FeedStateIn,
	type Fired,
	type IncidentsIn,
	type Memory,
	type MoneyIn,
	type NewsIn,
	type QuakesIn,
	type RuleStatus,
} from "./engine.ts";
import { type AlertRule, AlertRulesSchema } from "./schema.ts";

/**
 * Runs the alert rules: after new data lands in a panel a rule reads (debounced), and every 5 minutes (feeds go
 * stale without new data). Fired alerts are kept in a log (the newest 200) next to the rules' memory, in the data
 * directory, so a restart neither forgets nor repeats them. Nothing runs while there is no enabled rule.
 */

export const ALERT_LOG_LIMIT = 200;
/** Panels the rules read; a run that invalidates one of them re-evaluates. */
export const ALERT_PANELS = [
	"connectivity",
	"money",
	"quakes",
	"censorship",
	"incidents",
	"news",
	"user-news",
];

export interface AlertDeps {
	readonly file: string;
	readonly rules: () => readonly AlertRule[];
	readonly saveRules: (next: readonly AlertRule[]) => void;
	readonly panel: (id: string) => unknown;
	readonly health: () => readonly FeedHealth[];
	/** Sends each fired alert to open pages (SSE). */
	readonly publish: (alert: Fired) => void;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

interface Saved {
	v: 1;
	memory: Memory;
	log: Fired[];
}

export interface AlertsView {
	now: number;
	rules: readonly AlertRule[];
	status: Record<string, RuleStatus>;
	/** Newest first. */
	log: Fired[];
	/** When the rules were last evaluated; null before the first evaluation. */
	evaluatedAt: number | null;
}

export class AlertService {
	readonly #deps: AlertDeps;
	readonly #now: () => number;
	#memory: Memory = emptyMemory();
	#log: Fired[] = [];
	#status: Record<string, RuleStatus> = {};
	#evaluatedAt: number | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#interval: ReturnType<typeof setInterval> | null = null;

	constructor(deps: AlertDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#load();
	}

	#load(): void {
		try {
			if (!existsSync(this.#deps.file)) return;
			const saved = JSON.parse(readFileSync(this.#deps.file, "utf8")) as Partial<Saved>;
			if (saved.v !== 1) return;
			if (saved.memory?.v === 1 && saved.memory.rules && typeof saved.memory.rules === "object")
				this.#memory = saved.memory;
			if (Array.isArray(saved.log)) this.#log = saved.log.slice(0, ALERT_LOG_LIMIT);
		} catch {
			// A corrupt file: start over. The rules' first evaluation is a baseline, so nothing is re-announced.
			this.#deps.log?.("alertas: archivo de memoria dañado; se empieza de cero");
		}
	}

	#save(): void {
		try {
			mkdirSync(dirname(this.#deps.file), { recursive: true });
			const saved: Saved = { v: 1, memory: this.#memory, log: this.#log };
			writeFileSync(`${this.#deps.file}.tmp`, JSON.stringify(saved));
			renameSync(`${this.#deps.file}.tmp`, this.#deps.file);
		} catch (error) {
			this.#deps.log?.(`alertas: no se pudo guardar (${error instanceof Error ? error.message : error})`);
		}
	}

	start(): void {
		this.#interval ??= setInterval(() => this.run(), 5 * 60_000);
		this.#interval.unref?.();
		this.schedule(10_000);
	}

	stop(): void {
		if (this.#timer) clearTimeout(this.#timer);
		if (this.#interval) clearInterval(this.#interval);
		this.#timer = null;
		this.#interval = null;
	}

	/** Re-evaluates soon (coalesces bursts of feed runs into one evaluation). */
	schedule(delayMs = 3_000): void {
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.run();
		}, delayMs);
		this.#timer.unref?.();
	}

	/** Call after a feed run that inserted data: re-evaluates when one of the rules' panels changed. */
	onPanelsChanged(panels: readonly string[]): void {
		if (panels.some((p) => ALERT_PANELS.includes(p))) this.schedule();
	}

	/** Evaluates every rule now. Returns the alerts fired. */
	run(): Fired[] {
		const rules = this.#deps.rules();
		const now = this.#now();
		const enabled = rules.filter((r) => r.enabled);
		if (!enabled.length) {
			this.#status = Object.fromEntries(rules.map((r) => [r.id, { state: "off", matching: 0, note: null }]));
			this.#evaluatedAt = now;
			// Keep no memory for rules that no longer exist or are off.
			if (Object.keys(this.#memory.rules).length) {
				this.#memory = emptyMemory();
				this.#save();
			}
			return [];
		}
		const kinds = new Set(enabled.map((r) => r.kind));
		const read = <T>(id: string, needed: boolean): T | undefined =>
			needed ? (this.#deps.panel(id) as T | undefined) : undefined;
		const health = new Map(this.#deps.health().map((h) => [h.id, h.state as FeedStateIn]));
		let result: ReturnType<typeof evaluate>;
		try {
			result = evaluate(
				rules,
				{
					now,
					connectivity: read<ConnectivityIn>("connectivity", kinds.has("connectivity")),
					money: read<MoneyIn>("money", kinds.has("gap") || kinds.has("rate")),
					quakes: read<QuakesIn>("quakes", kinds.has("quake")),
					censorship: read<CensorshipIn>("censorship", kinds.has("blocked")),
					incidents: read<IncidentsIn>("incidents", kinds.has("incident")),
					news: kinds.has("news") ? [read<NewsIn>("news", true), read<NewsIn>("user-news", true)] : [],
					feedState: (id) => health.get(id) ?? null,
				},
				this.#memory,
			);
		} catch (error) {
			this.#deps.log?.(`alertas: error al evaluar (${error instanceof Error ? error.message : error})`);
			return [];
		}
		this.#memory = result.memory;
		this.#status = result.status;
		this.#evaluatedAt = now;
		if (result.fired.length) {
			const known = new Set(this.#log.map((a) => a.id));
			const fresh = result.fired.filter((a) => !known.has(a.id));
			this.#log = [...fresh.reverse(), ...this.#log].slice(0, ALERT_LOG_LIMIT);
			for (const alert of fresh) {
				try {
					this.#deps.publish(alert);
				} catch {
					// An SSE failure never loses the alert: it is in the log.
				}
			}
		}
		this.#save();
		return result.fired;
	}

	view(): AlertsView {
		return {
			now: this.#now(),
			rules: this.#deps.rules(),
			status: this.#status,
			log: this.#log,
			evaluatedAt: this.#evaluatedAt,
		};
	}

	/** Replaces the rule list (validated). New rules start from a baseline at the next evaluation, run at once. */
	setRules(input: unknown): { ok: true } | { ok: false; reason: string } {
		const parsed = AlertRulesSchema.safeParse(input);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return {
				ok: false,
				reason: `Regla no válida${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}.`,
			};
		}
		// An edited rule is a new rule: it starts from a new baseline instead of firing for what is already true.
		const before = new Map(this.#deps.rules().map((r) => [r.id, JSON.stringify({ ...r, enabled: true })]));
		const rules = { ...this.#memory.rules };
		for (const r of parsed.data) {
			if (before.get(r.id) !== JSON.stringify({ ...r, enabled: true })) delete rules[r.id];
		}
		this.#memory = { v: 1, rules };
		this.#deps.saveRules(parsed.data);
		this.run();
		return { ok: true };
	}

	clearLog(): void {
		this.#log = [];
		this.#save();
	}
}
