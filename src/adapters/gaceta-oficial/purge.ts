import type { Store } from "../../core/store.ts";
import type { Json } from "../../core/types.ts";
import { redactRows } from "../../intel/chain.ts";
import { type GacetaAct, gacetaOficial } from "./index.ts";
import { type ActCategory, classifyAct, stripIds } from "./redact.ts";

/** One stored act, of any version, under today's rule (redact.ts); null when it is not an act. */
function redactAct(a: unknown): GacetaAct | null {
	if (!a || typeof a !== "object") return null;
	const o = a as Record<string, unknown>;
	const organ = typeof o.organ === "string" ? stripIds(o.organ).text : "";
	const entity = typeof o.entity === "string" && o.entity ? stripIds(o.entity).text : null;
	const instrument = typeof o.instrument === "string" ? o.instrument : null;
	const c = typeof o.title === "string" && o.title ? classifyAct(o.title) : null;
	const withheld: ActCategory = typeof o.withheld === "string" ? (o.withheld as ActCategory) : "otro";
	return c?.listed
		? { organ, entity, title: c.title, instrument, withheld: null }
		: { organ, entity, title: null, instrument, withheld: c?.category ?? withheld };
}

/** A stored issue with every act re-classified; null when nothing changes. */
export function redactStoredIssue(value: Json): Json | null {
	if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.acts)) return null;
	const acts = value.acts.map(redactAct).filter((a): a is GacetaAct => a !== null);
	return { ...value, acts: acts as unknown as Json };
}

/**
 * Re-applies the Gaceta rule to every stored issue (code review 4, H1): versions before 25 Sept 2026 kept titles
 * whose names the old redaction missed. Runs at every start (a few hundred rows; a restored backup is covered too)
 * and changes only rows that still hold text the rule would not keep. Returns how many rows were rewritten.
 */
export function purgeStoredGaceta(store: Store, now: number): number {
	return redactRows(store, gacetaOficial.id, redactStoredIssue, now);
}
