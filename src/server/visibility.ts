/**
 * What one request may read: the single source of truth for "public panels" and "public sources" (code review 4,
 * H3). The user's own feeds ("Mis fuentes") and their panel are personal: on a LAN they reach only the browser that
 * holds the session cookie (`privateOk` in app.ts), and a public mirror has none. Every read route (panels,
 * evidence, meta, health, stream, terminal, report, /api/v1) asks this object instead of repeating the rule.
 */

/** Panels that show the user's own data; served only to a request that may see personal data. */
export const PERSONAL_PANELS: ReadonlySet<string> = new Set(["user-news"]);

export interface Visibility {
	/** The request may see the user's own feeds, panel and alerts. */
	readonly personal: boolean;
	/** Whether a panel id may be served. */
	panel(id: string): boolean;
	/** Whether a source (feed) id may be served: false for the user's own feeds unless `personal`. */
	source(id: string): boolean;
	/** The panels of `all` this request may see. */
	panels<P extends { readonly id: string; readonly sources: readonly string[] }>(all: readonly P[]): P[];
}

/**
 * `isMine` tells a user feed's id (UserFeeds.isMine); a panel is public only when it is not personal and none of
 * its sources is a user feed.
 */
export function visibility(personal: boolean, isMine: (source: string) => boolean): Visibility {
	const source = (id: string) => personal || !isMine(id);
	return {
		personal,
		source,
		panel: (id) => personal || !PERSONAL_PANELS.has(id),
		panels: (all) =>
			personal ? [...all] : all.filter((p) => !PERSONAL_PANELS.has(p.id) && p.sources.every(source)),
	};
}
