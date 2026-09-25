"use client";

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type Lang, tr } from "@/lib/i18n";
import { CopyButton } from "./CopyButton";
import { Scroll } from "./Scroll";

/** One way to run a tab's install, e.g. Apple silicon or Intel: its download (if any) and its commands. */
export interface Variant {
	id: string;
	label: string;
	/** The archive to download: a direct link to the release asset, with its size as the release notes print it. */
	download?: { href: string; file: string; size: string };
	command: string;
}

export interface Install {
	id: string;
	label: string;
	/** What to do, in words (rendered on the server). */
	intro: ReactNode;
	variants: readonly Variant[];
	/** Below the commands: first run of unsigned files, checksums (rendered on the server). */
	after?: ReactNode;
}

type Os = "windows" | "macos" | "linux" | "phone";

/** The reader's system, from the browser on this page only. iPhone and iPad user agents contain "Mac OS X". */
function detect(): Os | null {
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod|Android/i.test(ua)) return "phone";
	// iPadOS asks for the desktop site: a "Macintosh" with a touch screen.
	if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "phone";
	if (/Windows/i.test(ua)) return "windows";
	if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
	if (/Linux|X11|CrOS/i.test(ua)) return "linux";
	return null;
}

/**
 * The install steps as tabs (WAI-ARIA tabs: arrow keys move, Home/End jump). The reader's system picks the first tab;
 * on a phone, nothing is picked and a note says that Vigía runs on a computer.
 */
export function InstallTabs({
	lang,
	tabs,
	phoneNote,
}: {
	lang: Lang;
	tabs: readonly Install[];
	phoneNote: ReactNode;
}) {
	const t = tr(lang);
	const base = useId();
	const [active, setActive] = useState(tabs[0]?.id ?? "");
	const [variant, setVariant] = useState<Record<string, string>>({});
	const [phone, setPhone] = useState(false);
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		const os = detect();
		if (os === "phone") setPhone(true);
		else if (os && tabs.some((x) => x.id === os)) setActive(os);
	}, [tabs]);
	const index = tabs.findIndex((x) => x.id === active);
	// One underline that slides to the active tab (CSS transition; instant under reduced motion).
	const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
	useLayoutEffect(() => {
		const el = refs.current[index];
		if (el) setBar({ left: el.offsetLeft + 8, width: el.offsetWidth - 16 });
	}, [index]);
	const current = tabs[index];
	const chosen = current
		? (current.variants.find((v) => v.id === variant[current.id]) ?? current.variants[0])
		: undefined;
	const move = (to: number) => {
		const n = (to + tabs.length) % tabs.length;
		const next = tabs[n];
		if (!next) return;
		setActive(next.id);
		refs.current[n]?.focus();
	};
	return (
		<div className="flex flex-col gap-4">
			{phone ? (
				<p className="flex gap-3 rounded-xl border border-signal/40 bg-signal-soft p-4 text-[0.9375rem] leading-relaxed text-text">
					<svg
						width="18"
						height="18"
						viewBox="0 0 18 18"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						className="mt-0.5 shrink-0 text-signal"
						aria-hidden="true"
					>
						<rect x="2" y="3" width="14" height="9" rx="1.5" />
						<path d="M6 15h6M9 12v3" strokeLinecap="round" />
					</svg>
					<span>{phoneNote}</span>
				</p>
			) : null}
			<div className="frame">
				<div
					role="tablist"
					aria-label={t("Cómo instalar", "How to install")}
					className="relative flex gap-1 overflow-x-auto border-b border-line bg-surface-1 px-2 [scrollbar-width:none]"
				>
					{tabs.map((tab, i) => {
						const on = tab.id === active;
						return (
							<button
								key={tab.id}
								ref={(el) => {
									refs.current[i] = el;
								}}
								type="button"
								role="tab"
								id={`${base}-tab-${tab.id}`}
								aria-selected={on}
								aria-controls={`${base}-panel`}
								tabIndex={on ? 0 : -1}
								onClick={() => setActive(tab.id)}
								onKeyDown={(e) => {
									if (e.key === "ArrowRight") move(i + 1);
									else if (e.key === "ArrowLeft") move(i - 1);
									else if (e.key === "Home") move(0);
									else if (e.key === "End") move(tabs.length - 1);
									else return;
									e.preventDefault();
								}}
								className={`relative shrink-0 px-3.5 py-3 text-[0.875rem] font-medium transition-colors ${on ? "text-text" : "text-text-3 hover:text-text-2"}`}
							>
								{tab.label}
							</button>
						);
					})}
					{bar ? (
						<span
							aria-hidden="true"
							className="pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-text transition-[left,width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
							style={{ left: bar.left, width: bar.width }}
						/>
					) : null}
				</div>
				{current && chosen ? (
					<div
						role="tabpanel"
						id={`${base}-panel`}
						aria-labelledby={`${base}-tab-${current.id}`}
						className="bg-surface-0 p-5 sm:p-6"
					>
						<div className="text-[0.9375rem] leading-relaxed text-text-2">{current.intro}</div>
						{current.variants.length > 1 ? (
							<fieldset className="mt-4 flex flex-wrap gap-2">
								<legend className="sr-only">{t("Tu equipo", "Your machine")}</legend>
								{current.variants.map((v) => {
									const on = v.id === chosen.id;
									return (
										<label
											key={v.id}
											className={`chip cursor-pointer transition-colors has-[:focus-visible]:shadow-[var(--focus)] ${on ? "!border-text-3 !text-text" : "hover:text-text"}`}
										>
											<input
												type="radio"
												name={`${base}-${current.id}`}
												value={v.id}
												checked={on}
												onChange={() => setVariant((m) => ({ ...m, [current.id]: v.id }))}
												className="sr-only"
											/>
											{v.label}
										</label>
									);
								})}
							</fieldset>
						) : null}
						{chosen.download ? (
							<a
								href={chosen.download.href}
								className="mt-4 flex items-center gap-3 rounded-lg border border-line-strong bg-surface-1 px-4 py-3 transition-colors hover:border-text-3"
								rel="noopener"
							>
								<svg
									width="16"
									height="16"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="shrink-0 text-text-2"
									aria-hidden="true"
								>
									<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11" />
								</svg>
								<span className="data min-w-0 flex-1 break-all text-[0.8125rem] text-text">
									{chosen.download.file}
								</span>
								<span className="data shrink-0 text-[0.8125rem] text-text-3">{chosen.download.size}</span>
							</a>
						) : null}
						<div className="mt-3 flex items-start gap-3 rounded-lg border border-line bg-bg p-4">
							{/* One string child: small DOM and payload. */}
							<Scroll label={t("Comandos", "Commands")} className="min-w-0 flex-1">
								<pre className="code whitespace-pre text-text">{chosen.command}</pre>
							</Scroll>
							<CopyButton lang={lang} text={chosen.command} />
						</div>
						{current.after ? (
							<div className="mt-4 space-y-3 text-[0.875rem] leading-relaxed text-text-2">
								{current.after}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
