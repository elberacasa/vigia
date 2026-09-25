"use client";

import { useState } from "react";
import { type Lang, tr } from "@/lib/i18n";

export function CopyButton({ lang, text }: { lang: Lang; text: string }) {
	const t = tr(lang);
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setDone(true);
					setTimeout(() => setDone(false), 1600);
				} catch {
					// Clipboard blocked: the text stays selectable.
				}
			}}
			className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line text-text-3 transition-colors hover:border-line-strong hover:text-text"
			aria-label={done ? t("Copiado", "Copied") : t("Copiar", "Copy")}
			title={done ? t("Copiado", "Copied") : t("Copiar", "Copy")}
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				aria-hidden="true"
			>
				{done ? (
					<path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
				) : (
					<>
						<rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
						<path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
					</>
				)}
			</svg>
			<span className="sr-only" aria-live="polite">
				{done ? t("Copiado", "Copied") : ""}
			</span>
		</button>
	);
}
