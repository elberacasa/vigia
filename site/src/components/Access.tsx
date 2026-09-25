import type { Access as A } from "@/lib/catalog";
import { type Lang, tr } from "@/lib/i18n";

/** How a source starts on a fresh install, in words: no key, needs a free key, or off until you turn it on. */
export function accessLabel(lang: Lang, a: A): string {
	const t = tr(lang);
	return a === "free"
		? t("sin clave", "no key")
		: a === "key"
			? t("con clave", "needs a key")
			: t("opcional", "opt-in");
}

export function AccessTag({ lang, access, quiet = false }: { lang: Lang; access: A; quiet?: boolean }) {
	return (
		<span className={`access access--${access}${quiet ? " access--quiet" : ""}`}>
			<span className="access__dot" aria-hidden="true" />
			<span className={quiet ? "sr-only" : undefined}>{accessLabel(lang, access)}</span>
		</span>
	);
}
