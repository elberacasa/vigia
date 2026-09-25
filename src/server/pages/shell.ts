/**
 * Server-rendered pages outside the app (the API documentation, the printable report): plain HTML with the design
 * system's colours and fonts, no script (so the CSP's `script-src 'self'` has nothing to allow), readable on a
 * phone, in dark and light, and printable. They cost the app's first load nothing: they are separate URLs.
 */

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escapes text for HTML content and attribute values. */
export function h(value: string | number | null | undefined): string {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Only http(s) links are ever rendered as links. */
export function safeHref(url: string | null | undefined): string | null {
	return typeof url === "string" && /^https?:\/\/[^\s"<>]+$/.test(url) ? url : null;
}

const BASE_CSS = `
@font-face{font-family:"Archivo";src:url("/fonts/archivo-2.woff2") format("woff2");font-weight:400 800;font-display:swap}
@font-face{font-family:"Chivo Mono";src:url("/fonts/chivo-mono-1.woff2") format("woff2");font-weight:400 700;font-display:swap}
:root{color-scheme:dark;--bg:#07090e;--surface:#10141c;--surface-2:#161b25;--line:#232a37;--text:#edeff3;--text-2:#aab2c0;--text-3:#8a94a7;--signal:#f6b532;--info:#6cb4ff;--ok:#3fd49a;--warn:#ff9f43;--alert:#ff5a5f;
--font-ui:"Archivo",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-data:"Chivo Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f1ea;--surface:#ffffff;--surface-2:#f3f0e9;--line:#e2ddd2;--text:#14181f;--text-2:#4a5263;--text-3:#5c6577;--signal:#8a5a00;--info:#1a62bd;--ok:#0b7a53;--warn:#9a4c00;--alert:#c8262c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 var(--font-ui)}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}
a{color:var(--info);text-underline-offset:2px}
a:focus-visible,summary:focus-visible,[tabindex="0"]:focus-visible{outline:2px solid var(--signal);outline-offset:2px;border-radius:2px}
h1{font-size:1.75rem;line-height:1.15;margin:.25rem 0 .5rem;letter-spacing:-.01em}
h2{font-size:1.125rem;margin:2rem 0 .5rem;padding-top:.5rem;border-top:1px solid var(--line)}
h3{font-size:1rem;margin:1.25rem 0 .25rem}
p,li{max-width:72ch}
.kicker{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:var(--signal);font-weight:700;margin:0}
.lede{color:var(--text-2);margin:0 0 1rem}
.note{color:var(--text-2);font-size:.875rem}
code,.mono,time{font-family:var(--font-data);font-size:.8125rem}
code{background:var(--surface-2);padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;font-size:.8125rem}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;font-size:.875rem}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--text-2);font-weight:600;font-size:.8125rem}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tag{display:inline-block;font-size:.75rem;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--text-2)}
.tag--stale{border-color:var(--warn);color:var(--warn)}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;background:var(--surface);padding:8px;z-index:1}
`;

export function page(options: {
	readonly title: string;
	readonly lang: "es" | "en";
	readonly description: string;
	readonly body: string;
	readonly css?: string;
}): string {
	return `<!doctype html>
<html lang="${options.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${h(options.description)}">
<meta name="referrer" content="no-referrer">
<title>${h(options.title)}</title>
<link rel="icon" href="/icons/icon-192.png">
<style>${BASE_CSS}${options.css ?? ""}</style>
</head>
<body>
<a class="skip" href="#contenido">${options.lang === "es" ? "Saltar al contenido" : "Skip to content"}</a>
<main id="contenido">
${options.body}
</main>
</body>
</html>`;
}

export function htmlResponse(html: string, cacheSeconds = 60, request?: Request): Response {
	return new Response(request?.method === "HEAD" ? null : html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
		},
	});
}
