import { z } from "zod";

/**
 * Alert rules ("Mis alertas"), stored in config.json. Each rule is a condition code evaluates on the server against
 * the same panel computations the page shows (src/alerts/engine.ts); no model is involved.
 */

export const ALERT_RULE_LIMIT = 50;
export const RULE_ID = /^r-[0-9a-z]{6,16}$/;
/** A state (ISO 3166-2), the whole country ("VE"), or any state ("*"). */
const PLACE = z.string().regex(/^(\*|VE|VE-[A-Z])$/);
const STATE_OR_ANY = z.string().regex(/^(\*|VE-[A-Z])$/);

const base = {
	id: z.string().regex(RULE_ID),
	/** Optional label the user gives the rule. */
	name: z.string().trim().max(60).optional(),
	enabled: z.boolean(),
	createdAt: z.number().int().min(0),
};

export const AlertRuleSchema = z.discriminatedUnion("kind", [
	/** A state's (or the country's) internet connectivity reaches a level (IODA, the connectivity panel's rule). */
	z
		.object({ ...base, kind: z.literal("connectivity"), place: PLACE, level: z.enum(["drop", "severe"]) })
		.strict(),
	/** The gap between Yadio's dollar and the BCV's official rate reaches a percentage. */
	z.object({ ...base, kind: z.literal("gap"), minPct: z.number().min(0).max(1_000) }).strict(),
	/** The BCV's official dollar reaches a rate in bolívares. */
	z.object({ ...base, kind: z.literal("rate"), minVes: z.number().positive().max(1e9) }).strict(),
	/** An earthquake of at least this magnitude, in a state or within `radiusKm` of it (or anywhere in or near Venezuela). */
	z
		.object({
			...base,
			kind: z.literal("quake"),
			minMag: z.number().min(2).max(9),
			state: STATE_OR_ANY,
			radiusKm: z.number().int().min(0).max(300),
		})
		.strict(),
	/** A domain is newly blocked (VE sin Filtro) or newly flagged as possibly blocked (OONI). "*" is any domain. */
	z
		.object({
			...base,
			kind: z.literal("blocked"),
			domain: z
				.string()
				.trim()
				.toLowerCase()
				.regex(/^(\*|[a-z0-9-]+(\.[a-z0-9-]+)+)$/)
				.max(253),
		})
		.strict(),
	/** An incident opens (two or more independent signal families, or several outlets) in a state or anywhere. */
	z
		.object({
			...base,
			kind: z.literal("incident"),
			state: STATE_OR_ANY,
			incident: z.enum(["any", "corte", "sismo"]),
		})
		.strict(),
	/** A new story whose headline contains every word of one of the phrases (Vigía's outlets and yours). */
	z
		.object({
			...base,
			kind: z.literal("news"),
			/** Comma-separated phrases; a story matches when its title contains every word of one of them. */
			terms: z.string().trim().min(2).max(200),
			state: STATE_OR_ANY,
		})
		.strict(),
]);

export type AlertRule = z.infer<typeof AlertRuleSchema>;
export type AlertKind = AlertRule["kind"];

export const AlertRulesSchema = z
	.array(AlertRuleSchema)
	.max(ALERT_RULE_LIMIT)
	.refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "ids repetidos");
