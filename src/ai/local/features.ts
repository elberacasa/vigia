/**
 * Features for the bundled local classifier: words and word pairs of the normalised headline (weighted) and summary,
 * plus the gazetteer's candidate states (code proposes, the model weighs). Hashed into a fixed space so the model
 * needs no vocabulary file. Deterministic and pure.
 */
import { tagPlaces } from "../../news/places.ts";
import { normalize, STOPWORDS } from "../../news/text.ts";
import { topics as ruleTopics } from "../../news/topics.ts";

export const HASH_BITS = 18;
const MASK = (1 << HASH_BITS) - 1;

export interface FeatureInput {
	readonly title: string;
	readonly summary: string;
	readonly region: string;
}

function hash(s: string): number {
	return Number(Bun.hash.wyhash(s, 7n) & BigInt(MASK));
}

/** Sparse feature vector: bucket → value (weights accumulate on collisions). */
export function features(item: FeatureInput): Map<number, number> {
	const out = new Map<number, number>();
	const add = (key: string, w: number) => {
		const h = hash(key);
		out.set(h, (out.get(h) ?? 0) + w);
	};
	const words = (text: string) =>
		normalize(text)
			.split(" ")
			.filter((w) => w && !STOPWORDS.has(w));
	const title = words(item.title);
	const summary = words(item.summary);
	for (let i = 0; i < title.length; i++) {
		add(`t:${title[i]}`, 1);
		if (i + 1 < title.length) add(`t2:${title[i]}_${title[i + 1]}`, 1);
	}
	for (let i = 0; i < summary.length; i++) {
		add(`s:${summary[i]}`, 0.5);
		if (i + 1 < summary.length) add(`s2:${summary[i]}_${summary[i + 1]}`, 0.5);
	}
	// L2-normalise the text features so long summaries do not dominate…
	let norm = 0;
	for (const v of out.values()) norm += v * v;
	norm = Math.sqrt(norm) || 1;
	for (const [k, v] of out) out.set(k, v / norm);
	// …then add the structured signals at full weight: code's own findings (keyword topics, gazetteer places),
	// which the model learns to trust or discount.
	for (const t of ruleTopics(`${item.title}. ${item.summary}`)) add(`rule:${t}`, 1);
	const international = item.region === "international";
	add(`region:${international ? "intl" : item.region.startsWith("VE-") ? "regional" : item.region}`, 1);
	const places = tagPlaces(`${item.title}. ${item.summary}`, {
		venezuelanOutlet: !international,
		...(item.region.startsWith("VE-") ? { homeState: item.region } : {}),
	});
	for (const m of places.mentions) add(`cand:${m.state}`, m.confidence);
	if (places.primaryState) add(`primary:${places.primaryState}`, 1);
	if (places.mentions.length === 0) add("cand:none", 1);
	add("bias", 1);
	return out;
}
