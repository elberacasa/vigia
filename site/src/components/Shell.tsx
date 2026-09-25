import type { ReactNode } from "react";
import type { Lang, Page } from "@/lib/i18n";
import { Footer } from "./Closing";
import { CountObserver } from "./CountObserver";
import { Header } from "./Header";
import { RevealObserver } from "./RevealObserver";

/** A page of the site: the header, its content, the footer, and the two scroll observers. */
export function Shell({ lang, page, children }: { lang: Lang; page: Page; children: ReactNode }) {
	return (
		<>
			<Header lang={lang} page={page} />
			<main id="contenido">{children}</main>
			<Footer lang={lang} ruled={page !== "home"} />
			<RevealObserver />
			<CountObserver />
		</>
	);
}
