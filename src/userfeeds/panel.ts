import type { Store } from "../core/store.ts";
import { type NewsView, newsView } from "../panels/news.ts";
import type { Panel } from "../server/panels.ts";
import type { UserFeeds } from "./service.ts";

export type UserNewsView = NewsView & {
	/** The feeds this view is built from, in the order they were added. */
	feeds: { id: string; name: string; region: string }[];
	/** Always true: every story here comes from a feed the user added ("añadida por ti"). */
	mine: true;
};

/**
 * "Mis fuentes": the news panel's computation (same tagging, clustering and windows) over the user's own feeds
 * only. Kept apart from Vigía's news panel so a hand-added feed never changes Vigía's totals, map or incidents.
 */
export function userNewsPanel(feeds: UserFeeds): Panel<UserNewsView> {
	return {
		id: "user-news",
		get sources() {
			return feeds.list().map((f) => f.id);
		},
		compute: (store: Store, now: number) => ({
			...newsView(store, now, feeds.outlets()),
			feeds: feeds.list().map((f) => ({ id: f.id, name: f.name, region: f.region })),
			mine: true,
		}),
	};
}
