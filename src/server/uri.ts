/**
 * `decodeURIComponent` that answers `null` instead of throwing on a malformed escape (`%E0%A4%A`), so every route
 * can turn a bad path segment into a 400 rather than a 500 (review 4 L1). The one place a path segment is decoded.
 */
export function decodeSegment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}
