import "server-only";
import { anchor, versions } from "./catalog";
import { type Lang, PATHS, REPO, tr } from "./i18n";
import { escapeXml, mdHtml } from "./markdown";
import { SITE_URL } from "./meta";

const KIND_ES: Readonly<Record<string, string>> = {
	added: "Añadido",
	changed: "Cambiado",
	fixed: "Arreglado",
	removed: "Quitado",
	deprecated: "En desuso",
	security: "Seguridad",
	"known limits": "Límites conocidos",
};

/** The changelog as an Atom feed, one entry per version, written at build time (app/cambios.xml). */
export function atom(lang: Lang): string {
	const t = tr(lang);
	const page = new URL(PATHS.changelog[lang], SITE_URL).toString();
	const self = new URL(PATHS.feed[lang], SITE_URL).toString();
	const stamp = (date: string) => `${date}T00:00:00Z`;
	const entries = versions.map((v) => {
		const url = `${page}#${anchor(v.version)}`;
		const topics = v.topics[lang].join(" · ");
		const groups = v.groups
			.map(
				(g) =>
					`<h3>${escapeXml(lang === "es" ? (KIND_ES[g.kind] ?? g.title) : g.title)}</h3><ul>${g.items.map((i) => `<li>${mdHtml(i)}</li>`).join("")}</ul>`,
			)
			.join("");
		const html = [
			`<ul>${v.highlights[lang].map((h) => `<li>${mdHtml(h)}</li>`).join("")}</ul>`,
			`<h2>${escapeXml(t("Registro completo (en inglés)", "Full changelog"))}</h2>`,
			groups,
			`<p><a href="${escapeXml(`${REPO}/releases/tag/v${v.version}`)}">${escapeXml(t("Versión y descargas en GitHub", "Release and downloads on GitHub"))}</a></p>`,
		].join("");
		return [
			"<entry>",
			`<id>${escapeXml(url)}</id>`,
			`<title>${escapeXml(`Vigía ${v.version}${topics ? `: ${topics}` : ""}`)}</title>`,
			`<link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
			`<updated>${stamp(v.date)}</updated>`,
			`<content type="html">${escapeXml(html)}</content>`,
			"</entry>",
		].join("");
	});
	return [
		'<?xml version="1.0" encoding="utf-8"?>',
		`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${lang}">`,
		`<id>${escapeXml(page)}</id>`,
		`<title>${escapeXml(t("Vigía: novedades", "Vigía: changelog"))}</title>`,
		`<subtitle>${escapeXml(t("Cada versión de Vigía, de la más nueva a la primera.", "Every version of Vigía, newest first."))}</subtitle>`,
		`<link rel="alternate" type="text/html" href="${escapeXml(page)}"/>`,
		`<link rel="self" type="application/atom+xml" href="${escapeXml(self)}"/>`,
		`<updated>${stamp(versions[0]?.date ?? "1970-01-01")}</updated>`,
		"<author><name>Vigía</name></author>",
		`<icon>${escapeXml(new URL("/icon.svg", SITE_URL).toString())}</icon>`,
		...entries,
		"</feed>",
		"",
	].join("\n");
}

export const feedResponse = (lang: Lang) =>
	new Response(atom(lang), {
		headers: { "content-type": "application/atom+xml; charset=utf-8" },
	});
