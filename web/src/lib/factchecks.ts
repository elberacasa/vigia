/* The fact-checks view (`/api/panels/desmentidos`, src/panels/factcheck.ts) and what the news list borrows from it. */

export type Verdict = "false" | "misleading" | "context" | "partly" | "unproven" | "satire" | "true";

export interface RelatedStory {
	title: string;
	url: string;
	outlet: string;
	outletName: string;
	at: number;
	sharedWords: string[];
	overlap: number;
}

export interface FactCheck {
	id: string;
	title: string;
	url: string;
	at: number;
	dateMissing: boolean;
	checker: string;
	checkerName: string;
	via: "google-news" | null;
	verdict: Verdict | null;
	related: RelatedStory | null;
}

export interface FactCheckView {
	from: number;
	to: number;
	items: FactCheck[];
	byChecker: { id: string; name: string; items: number }[];
	byVerdict: Partial<Record<Verdict | "none", number>>;
	related: number;
	verdicts: Record<Verdict, { es: string; en: string }>;
	methodEs: string;
	methodEn: string;
}

/**
 * News story links that a fact-check names as its possible relation (a match of words, never a confirmation), each
 * with the checks that point at it, newest first. The news list marks those stories with the checker and verdict.
 */
export function checksByStoryUrl(view: FactCheckView | undefined): Map<string, FactCheck[]> {
	const out = new Map<string, FactCheck[]>();
	for (const f of view?.items ?? []) {
		if (!f.related) continue;
		const list = out.get(f.related.url);
		if (list) list.push(f);
		else out.set(f.related.url, [f]);
	}
	for (const list of out.values()) list.sort((a, b) => b.at - a.at);
	return out;
}
