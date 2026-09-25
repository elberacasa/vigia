import type { ReactNode } from "react";
import { blob } from "./i18n";

/**
 * Inline Markdown as the changelog and release notes write it: **bold**, `code` and [links](url). Nothing else is
 * interpreted, and text is never injected as HTML: the React renderer builds elements, the feed renderer escapes.
 */
export type Token =
	| { t: "text"; v: string }
	| { t: "strong"; v: string }
	| { t: "code"; v: string }
	| { t: "link"; v: string; href: string };

export function tokens(md: string): Token[] {
	const out: Token[] = [];
	const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
	let at = 0;
	for (const m of md.matchAll(re)) {
		if (m.index > at) out.push({ t: "text", v: md.slice(at, m.index) });
		if (m[1] !== undefined) out.push({ t: "strong", v: m[1] });
		else if (m[2] !== undefined) out.push({ t: "code", v: m[2] });
		else out.push({ t: "link", v: m[3] ?? "", href: resolve(m[4] ?? "") });
		at = m.index + m[0].length;
	}
	if (at < md.length) out.push({ t: "text", v: md.slice(at) });
	return out;
}

/** A repository path (docs/releases/v0.1.5.md) becomes its GitHub page; only http(s) links pass otherwise. */
function resolve(href: string): string {
	if (/^https?:\/\//.test(href)) return href;
	if (/^[\w./-]+$/.test(href) && !href.startsWith("/")) return blob(href.replace(/^\.\//, ""));
	return "#";
}

export function Md({ children }: { children: string }): ReactNode {
	return tokens(children).map((k, i) => {
		const key = `${i}-${k.t}`;
		switch (k.t) {
			case "strong":
				return (
					<strong key={key} className="font-semibold text-text">
						{k.v}
					</strong>
				);
			case "code":
				return (
					<code key={key} className="md-code">
						{k.v}
					</code>
				);
			case "link":
				return (
					<a key={key} className="link" href={k.href} target="_blank" rel="noopener noreferrer">
						{k.v}
					</a>
				);
			default:
				return k.v;
		}
	});
}

const escapeXml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The same inline Markdown as escaped HTML, for the Atom feed's content. */
export function mdHtml(md: string): string {
	return tokens(md)
		.map((k) => {
			switch (k.t) {
				case "strong":
					return `<strong>${escapeXml(k.v)}</strong>`;
				case "code":
					return `<code>${escapeXml(k.v)}</code>`;
				case "link":
					return `<a href="${escapeXml(k.href)}">${escapeXml(k.v)}</a>`;
				default:
					return escapeXml(k.v);
			}
		})
		.join("");
}

export { escapeXml };
