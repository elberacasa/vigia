import type { ReactNode } from "react";
import { archivo, chivo } from "@/lib/fonts";
import type { Lang } from "@/lib/i18n";
import "../../app/globals.css";

/**
 * Before the first paint: applies a saved theme (no flash); the page follows the system otherwise. The reveal-on-scroll
 * starting state is armed later, by RevealObserver itself, so content never stays hidden if the page's JavaScript
 * fails to load.
 */
const THEME = `try{var t=localStorage.getItem("vigia-site-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function Document({ lang, children }: { lang: Lang; children: ReactNode }) {
	return (
		<html lang={lang} className={`${archivo.variable} ${chivo.variable}`} suppressHydrationWarning>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant, inline so it runs before paint */}
				<script dangerouslySetInnerHTML={{ __html: THEME }} />
			</head>
			<body>{children}</body>
		</html>
	);
}
