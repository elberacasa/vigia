/**
 * Only http(s) links leave the page; anything else is not a link. Its own module so the first load (Entry.tsx)
 * does not carry it: only the alerts tab and the toasts, both on demand, use it.
 */
export function safeHref(url: string): string | undefined {
	return /^https?:\/\//i.test(url) ? url : undefined;
}
