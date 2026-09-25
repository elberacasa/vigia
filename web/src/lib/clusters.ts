/** The News panel's "most covered" ranking, as plain code with tests (web/src/lib/clusters.test.ts). */
export interface ClusterStory {
	at: number;
	outlets: readonly { id: string; at: number }[];
}

/** Distinct outlets that reported a story at or after `since` (one outlet publishing twice counts once). */
export function outletsSince(story: ClusterStory, since: number): number {
	return new Set(story.outlets.filter((o) => o.at >= since).map((o) => o.id)).size;
}

/**
 * The most covered stories: ranked by distinct outlets that reported them in the window, ties to the most recent
 * report. The window is 12 h; if fewer than three stories were carried by two or more outlets in 12 h, it widens
 * to 24 h, then 48 h, and says so. Rules only, no AI.
 */
export function topClusters<S extends ClusterStory>(
	stories: readonly S[],
	now: number,
	max = 5,
): { hours: number; items: { story: S; outlets: number }[] } {
	let pick: { hours: number; items: { story: S; outlets: number }[] } = { hours: 12, items: [] };
	for (const hours of [12, 24, 48]) {
		const since = now - hours * 3_600_000;
		const items = stories
			.map((story) => ({ story, outlets: outletsSince(story, since) }))
			.filter((x) => x.outlets >= 2)
			.sort((a, b) => b.outlets - a.outlets || b.story.at - a.story.at)
			.slice(0, max);
		pick = { hours, items };
		if (items.length >= 3) break;
	}
	return pick;
}
