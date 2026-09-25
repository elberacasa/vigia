"use client";

import { useEffect, useState } from "react";
import { type Lang, tr } from "@/lib/i18n";

type Theme = "light" | "dark";
const KEY = "vigia-site-theme";

function current(): Theme {
	const set = document.documentElement.dataset.theme;
	if (set === "light" || set === "dark") return set;
	return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Light or dark; the choice is kept on this device only (localStorage), and the system decides until then. */
export function ThemeToggle({ lang }: { lang: Lang }) {
	const t = tr(lang);
	const [theme, setTheme] = useState<Theme | null>(null);
	useEffect(() => setTheme(current()), []);
	const next: Theme = theme === "light" ? "dark" : "light";
	return (
		<button
			type="button"
			className="grid h-9 w-9 place-items-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
			aria-label={
				next === "light" ? t("Usar tema claro", "Use light theme") : t("Usar tema oscuro", "Use dark theme")
			}
			onClick={() => {
				document.documentElement.dataset.theme = next;
				try {
					localStorage.setItem(KEY, next);
				} catch {
					// Storage unavailable (private mode): the theme still changes for this visit.
				}
				setTheme(next);
			}}
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				aria-hidden="true"
			>
				{theme === "light" ? (
					<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
				) : (
					<>
						<circle cx="12" cy="12" r="4" />
						<path
							d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"
							strokeLinecap="round"
						/>
					</>
				)}
			</svg>
		</button>
	);
}
