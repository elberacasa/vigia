import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type AlertRule, AlertRulesSchema } from "../alerts/schema.ts";
import type { Adapter } from "../core/types.ts";
import { USER_FEED_LIMIT, type UserFeed, UserFeedSchema } from "../userfeeds/schema.ts";

/** User settings (config.json). Unknown keys are kept out; a broken file fails with a clear Spanish message. */
const Settings = z
	.object({
		/** Per-feed on/off overrides. Absent: the feed's default (on, unless opt-in). */
		feeds: z.record(z.string(), z.boolean()).default({}),
		/** Days of observations to keep; 0 keeps everything. */
		retentionDays: z.number().int().min(0).max(36_500).default(0),
		/** The AI section: which backend classifies news ("off" by default), and the paid budget per provider. */
		ai: z
			.object({
				news: z.enum(["off", "local", "jev"]).default("off"),
				brief: z.enum(["off", "anthropic", "claude-code", "ollama"]).default("off"),
				ollamaModel: z
					.string()
					.regex(/^[\w.:-]{1,64}$/)
					.default("llama3.1"),
				budgetUsd: z.record(z.string(), z.number().min(0).max(1_000)).default({}),
			})
			.strict()
			.default({ news: "off", brief: "off", ollamaModel: "llama3.1", budgetUsd: {} }),
		/** "Mis fuentes": RSS/Atom feeds the user added (src/userfeeds). */
		userFeeds: z.array(UserFeedSchema).max(USER_FEED_LIMIT).default([]),
		/** "Mis alertas": rules evaluated on the server (src/alerts). */
		alertRules: AlertRulesSchema.default([]),
	})
	.strict();

export type SettingsData = z.infer<typeof Settings>;

export interface SettingsStore {
	readonly data: SettingsData;
	feedEnabled(adapter: Adapter): boolean;
	setFeed(id: string, on: boolean): void;
	setAi(next: Partial<SettingsData["ai"]>): void;
	setUserFeeds(next: readonly UserFeed[]): void;
	setAlertRules(next: readonly AlertRule[]): void;
}

export function openSettings(configDir: string): SettingsStore {
	const path = join(configDir, "config.json");
	let data: SettingsData = Settings.parse({});
	if (existsSync(path)) {
		const parsed = Settings.safeParse(JSON.parse(readFileSync(path, "utf8")));
		if (!parsed.success) {
			throw new Error(`config.json no es válido (${path}): ${parsed.error.issues[0]?.message ?? ""}`);
		}
		data = parsed.data;
	}
	const persist = () => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
		renameSync(`${path}.tmp`, path);
	};
	return {
		get data() {
			return data;
		},
		feedEnabled: (adapter) => data.feeds[adapter.id] ?? adapter.optIn === undefined,
		setFeed: (id, on) => {
			data = { ...data, feeds: { ...data.feeds, [id]: on } };
			persist();
		},
		setAi: (next) => {
			// Budgets merge per provider: setting one never erases another.
			const budgetUsd = { ...data.ai.budgetUsd, ...(next.budgetUsd ?? {}) };
			data = { ...data, ai: { ...data.ai, ...next, budgetUsd } };
			persist();
		},
		setUserFeeds: (next) => {
			data = { ...data, userFeeds: [...next] };
			persist();
		},
		setAlertRules: (next) => {
			data = { ...data, alertRules: [...next] };
			persist();
		},
	};
}
