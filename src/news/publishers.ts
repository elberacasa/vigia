/**
 * One publisher can have several feeds (a regional section, a YouTube channel). Every count a reader sees ("12
 * medios", "de 240 medios", "two different outlets") is of publishers, never of feeds.
 */
import type { OutletSpec } from "../adapters/rss/factory.ts";
import { OUTLETS } from "../adapters/rss/outlets.ts";

export interface Publisher {
	readonly id: string;
	readonly name: string;
}

export function publishers(outlets: readonly OutletSpec[] = OUTLETS): Map<string, Publisher> {
	const byId = new Map(outlets.map((o) => [o.id, o]));
	const out = new Map<string, Publisher>();
	for (const o of outlets) {
		const main = o.publisher ? byId.get(o.publisher) : o;
		// A dangling publisher id is a bug in the list (a test guards it); fall back to the feed itself.
		out.set(o.id, main ? { id: main.id, name: main.name } : { id: o.id, name: o.name });
	}
	return out;
}

const DEFAULT = publishers();

/** The publisher of a feed id (itself when it is the publisher's main feed or unknown). */
export function publisherOf(feedId: string): Publisher {
	return DEFAULT.get(feedId) ?? { id: feedId, name: feedId };
}

/** Distinct publishers among these feeds. */
export function publisherCount(outlets: readonly OutletSpec[] = OUTLETS): number {
	return new Set([...publishers(outlets).values()].map((p) => p.id)).size;
}
