/**
 * The AI section at runtime: loads the bundled model, classifies new news items with the backend the user chose,
 * and computes the "ai" panel. Everything here is optional; the core never waits on it.
 */
import { OUTLETS } from "../adapters/rss/outlets.ts";
import type { Store } from "../core/store.ts";
import type { HttpLike, Json } from "../core/types.ts";
import { briefView } from "../panels/brief.ts";
import type { Panel } from "../server/panels.ts";
import {
	AnthropicWriter,
	type BriefWriter,
	ClaudeCodeWriter,
	OllamaWriter,
	type WrittenBrief,
	writeBrief,
} from "./brief-writer.ts";
import { NEWS_EVALUATION } from "./evaluation.ts";
import { JevJudge } from "./jev.ts";
import { Ledger } from "./ledger.ts";
import { LinearModel } from "./local/model.ts";
import modelPath from "./local/news-model.bin" with { type: "file" };
import {
	type AiNewsLabels,
	type Backend,
	classifyPending,
	LOCAL_MODEL_ID,
	recentItems,
	storedLabels,
} from "./news-ai.ts";

const HOUR = 3_600_000;

export interface AiSettings {
	news: Backend;
	brief: "off" | "anthropic" | "claude-code" | "ollama";
	ollamaModel: string;
	budgetUsd: Record<string, number>;
}

export type AiReport = {
	key: string;
	title: string;
	url: string;
	outlet: string;
	at: number;
	state: string;
	stateConfidence: number;
	probability: number;
	severity: number;
};

export type AiView = {
	backend: Backend;
	model: string | null;
	jevAvailable: boolean;
	evaluation: typeof NEWS_EVALUATION;
	spend: { provider: string; requests: number; costUsd: number; budgetUsd: number }[];
	lastRun: { at: number; labelled: number; error: string | null } | null;
	/** Items the model reads as reporting a power outage in Venezuela, last 48 h, newest first. */
	blackouts: AiReport[];
	/** Items the model reads as serious harm or disruption (severity ≥ 1.5 of 3), last 24 h. */
	serious: AiReport[];
	/** Blackout reports per state, 48 h. */
	blackoutsByState: Record<string, number>;
	labelledItems48h: number;
	briefBackend: AiSettings["brief"];
	anthropicAvailable: boolean;
	/** Today's written brief, when one was requested and passed validation. */
	writtenBrief: WrittenBrief | null;
};

export class AiRuntime {
	readonly ledger: Ledger;
	readonly jev: JevJudge;
	#local: LinearModel | null = null;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	lastRun: AiView["lastRun"] = null;

	constructor(
		readonly store: Store,
		readonly http: HttpLike,
		readonly key: (id: string) => string | undefined,
		readonly settings: () => AiSettings,
		readonly onChange: (labelled: number) => void,
		readonly now: () => number = Date.now,
	) {
		this.ledger = new Ledger(store, (provider) => settings().budgetUsd[provider] ?? 0, now);
		this.jev = new JevJudge(() => key("typesafe-api-key"), http, this.ledger, store);
	}

	async local(): Promise<LinearModel | null> {
		if (!this.#local) {
			try {
				this.#local = LinearModel.deserialize(new Uint8Array(await Bun.file(modelPath).arrayBuffer()));
			} catch (error) {
				console.error("[ai] modelo local:", error instanceof Error ? error.message : error);
			}
		}
		return this.#local;
	}

	/** Called after any news feed run; classification runs at most once per 30 s. */
	schedule(): void {
		if (this.settings().news === "off" || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.run();
		}, 30_000);
		this.#timer.unref?.();
	}

	async run(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const backend = this.settings().news;
			const items = recentItems(this.store, OUTLETS, this.now() - 48 * HOUR);
			const result = await classifyPending({
				store: this.store,
				backend,
				items,
				local: backend === "local" ? await this.local() : null,
				jev: backend === "jev" && this.key("typesafe-api-key") ? this.jev : null,
				now: this.now(),
			});
			this.lastRun = { at: this.now(), labelled: result.labelled, error: result.error };
			if (result.labelled > 0 || result.error) this.onChange(result.labelled);
		} catch (error) {
			this.lastRun = {
				at: this.now(),
				labelled: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			this.#running = false;
		}
	}

	view(): AiView {
		const s = this.settings();
		const now = this.now();
		const items = recentItems(this.store, OUTLETS, now - 48 * HOUR);
		const backend = s.news;
		let labels = new Map<string, AiNewsLabels>();
		let model: string | null = null;
		if (backend === "local") {
			model = LOCAL_MODEL_ID;
			labels = storedLabels(
				this.store,
				LOCAL_MODEL_ID,
				items.map((i) => i.key),
			);
		} else if (backend === "jev") {
			const row = this.store.db
				.query<{ model: string }, []>(
					"SELECT model FROM ai_outputs WHERE feature = 'news' AND model LIKE 'jev-%' ORDER BY at DESC LIMIT 1",
				)
				.get();
			model = row?.model ?? null;
			if (model)
				labels = storedLabels(
					this.store,
					model,
					items.map((i) => i.key),
				);
		}
		const reports: (AiReport & { blackoutP: number; about: number })[] = [];
		for (const it of items) {
			const l = labels.get(it.key);
			if (!l) continue;
			reports.push({
				key: it.key,
				title: it.item.title,
				url: it.item.link,
				outlet: it.outlet.name,
				at: 0,
				state: l.state,
				stateConfidence: l.stateConfidence,
				probability: l.blackout,
				severity: l.severity,
				blackoutP: l.blackout,
				about: l.aboutVenezuela,
			});
		}
		// Times: the item's stored observation time.
		const at = new Map<string, number>();
		for (const outlet of OUTLETS) {
			for (const o of this.store.latestPerSeries<{ link: string }>(outlet.id, now - 48 * HOUR, 400)) {
				at.set(Bun.hash(o.value.link).toString(36), o.observedAt);
			}
		}
		for (const r of reports) r.at = at.get(r.key) ?? 0;
		const strip = ({ blackoutP: _b, about: _a, ...r }: (typeof reports)[number]): AiReport => r;
		const blackouts = reports
			.filter((r) => r.blackoutP >= 0.5 && r.about >= 0.5)
			.sort((a, b) => b.at - a.at)
			.map((r) => strip({ ...r, probability: r.blackoutP }));
		const serious = reports
			.filter((r) => r.severity >= 1.5 && r.about >= 0.5 && r.at >= now - 24 * HOUR)
			.sort((a, b) => b.severity - a.severity || b.at - a.at)
			.slice(0, 20)
			.map(strip);
		const blackoutsByState: Record<string, number> = {};
		for (const r of blackouts)
			if (/^VE-/.test(r.state)) blackoutsByState[r.state] = (blackoutsByState[r.state] ?? 0) + 1;
		return {
			backend,
			model,
			jevAvailable: Boolean(this.key("typesafe-api-key")),
			evaluation: NEWS_EVALUATION,
			spend: (() => {
				const used = new Map(this.ledger.summary().map((x) => [x.provider, x]));
				const providers = new Set([...used.keys(), ...Object.keys(s.budgetUsd)]);
				return [...providers].map((provider) => ({
					provider,
					requests: used.get(provider)?.requests ?? 0,
					costUsd: used.get(provider)?.costUsd ?? 0,
					budgetUsd: s.budgetUsd[provider] ?? 0,
				}));
			})(),
			lastRun: this.lastRun,
			blackouts: blackouts.slice(0, 30),
			serious,
			blackoutsByState,
			labelledItems48h: labels.size,
			briefBackend: s.brief,
			anthropicAvailable: Boolean(this.key("anthropic-api-key")),
			writtenBrief: this.#todaysBrief(),
		};
	}

	#writer(): BriefWriter | null {
		const s = this.settings();
		if (s.brief === "anthropic") return new AnthropicWriter(() => this.key("anthropic-api-key"), this.ledger);
		if (s.brief === "claude-code") return new ClaudeCodeWriter();
		if (s.brief === "ollama") return new OllamaWriter(s.ollamaModel);
		return null;
	}

	#briefInFlight: Promise<WrittenBrief> | null = null;
	#lastBriefAt = 0;

	/**
	 * On demand only (may be a paid call): one at a time, at most one per minute. Concurrent requests share the one
	 * in flight instead of starting more model processes or paid calls.
	 */
	writeTodaysBrief(): Promise<WrittenBrief> {
		if (this.#briefInFlight) return this.#briefInFlight;
		if (this.now() - this.#lastBriefAt < 60_000) {
			return Promise.reject(new Error("Espera un minuto antes de volver a escribir el resumen."));
		}
		this.#lastBriefAt = this.now();
		this.#briefInFlight = this.#writeBrief().finally(() => {
			this.#briefInFlight = null;
		});
		return this.#briefInFlight;
	}

	async #writeBrief(): Promise<WrittenBrief> {
		const writer = this.#writer();
		if (!writer) throw new Error("Elige primero quién escribe el resumen.");
		const now = this.now();
		const written = await writeBrief(briefView(this.store, now), writer, now);
		this.store.db.run(
			"INSERT OR REPLACE INTO ai_outputs (feature, item, model, at, output) VALUES ('brief', ?, ?, ?, ?)",
			[written.day, written.model, now, JSON.stringify(written)],
		);
		this.onChange(1);
		return written;
	}

	#todaysBrief(): WrittenBrief | null {
		const day = new Date(this.now() - 4 * HOUR).toISOString().slice(0, 10);
		const row = this.store.db
			.query<{ output: string }, [string]>(
				"SELECT output FROM ai_outputs WHERE feature = 'brief' AND item = ? ORDER BY at DESC LIMIT 1",
			)
			.get(day);
		return row ? (JSON.parse(row.output) as WrittenBrief) : null;
	}

	panel(): Panel {
		return {
			id: "ai",
			sources: ["ai-news", ...OUTLETS.map((o) => o.id)],
			compute: () => this.view() as unknown as Json,
		};
	}
}
