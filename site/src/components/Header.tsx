"use client";

import { useEffect, useRef, useState } from "react";
import { IDEAS, type Lang, PATHS, type Page, REPO, tr } from "@/lib/i18n";
import { Mark, Wordmark } from "./Brand";
import { GitHubIcon } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

export function Header({ lang, page }: { lang: Lang; page: Page }) {
	const t = tr(lang);
	const [scrolled, setScrolled] = useState(false);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const on = () => setScrolled(window.scrollY > 8);
		on();
		window.addEventListener("scroll", on, { passive: true });
		return () => window.removeEventListener("scroll", on);
	}, []);
	const bar = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!open) return;
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		// A tap or click anywhere outside the header closes the menu.
		const outside = (e: PointerEvent) => {
			if (bar.current && !bar.current.contains(e.target as Node)) setOpen(false);
		};
		// The page behind the open menu stays put (no scrolling the content under it), and a wide screen closes it.
		const root = document.documentElement;
		const was = { overflow: root.style.overflow, overscroll: root.style.overscrollBehavior };
		root.style.overflow = "hidden";
		root.style.overscrollBehavior = "none";
		const wide = matchMedia("(min-width: 1024px)");
		const close = () => wide.matches && setOpen(false);
		window.addEventListener("keydown", esc);
		document.addEventListener("pointerdown", outside);
		wide.addEventListener("change", close);
		return () => {
			root.style.overflow = was.overflow;
			root.style.overscrollBehavior = was.overscroll;
			window.removeEventListener("keydown", esc);
			document.removeEventListener("pointerdown", outside);
			wide.removeEventListener("change", close);
		};
	}, [open]);

	// On the home page the sections are anchors; from the other pages they lead back to them.
	const home = page === "home" ? "" : PATHS.home[lang];
	const links: { href: string; label: string; current?: boolean; wide?: boolean }[] = [
		{ href: `${home}#que-muestra`, label: t("Qué muestra", "What it shows") },
		{ href: PATHS.sources[lang], label: t("Fuentes", "Sources"), current: page === "sources" },
		{ href: `${home}#principios`, label: t("Principios", "Principles"), wide: true },
		{ href: `${home}#instalar`, label: t("Instalar", "Install") },
		{ href: `${home}#desarrolladores`, label: t("Desarrolladores", "Developers"), wide: true },
		{ href: PATHS.changelog[lang], label: t("Novedades", "Changelog"), current: page === "changelog" },
	];
	const otherLang: Lang = lang === "es" ? "en" : "es";
	const other = PATHS[page][otherLang];

	return (
		<>
			<header
				ref={bar}
				className={`fixed inset-x-0 top-0 z-50 transition-[background-color,border-color,backdrop-filter] duration-300 ${
					open
						? "border-b border-line bg-bg"
						: scrolled
							? "border-b border-line bg-bg/80 backdrop-blur-xl backdrop-saturate-150"
							: "border-b border-transparent"
				}`}
			>
				<a
					href="#contenido"
					className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2"
				>
					{t("Saltar al contenido", "Skip to content")}
				</a>
				<div className="wrap flex h-16 items-center gap-6">
					<a
						href={PATHS.home[lang]}
						className="flex shrink-0 items-center gap-2.5 rounded-md"
						aria-label={t("Vigía, inicio", "Vigía, home")}
					>
						<Mark size={30} intro={page === "home"} />
						<Wordmark height={14} label={false} />
					</a>
					<nav aria-label={t("Secciones", "Sections")} className="hidden flex-1 lg:block">
						<ul className="flex items-center gap-0.5">
							{links.map((l) => (
								<li key={l.href} className={l.wide ? "hidden xl:block" : undefined}>
									<a
										href={l.href}
										aria-current={l.current ? "page" : undefined}
										className="nav-link whitespace-nowrap rounded-md px-3 py-2 text-[0.875rem] text-text-2 transition-colors hover:text-text"
									>
										{l.label}
									</a>
								</li>
							))}
						</ul>
					</nav>
					<div className="ml-auto flex items-center gap-1.5 lg:ml-0">
						<a
							href={other}
							hrefLang={otherLang}
							lang={otherLang}
							className="data grid h-9 min-w-9 place-items-center rounded-md px-2 text-[0.8125rem] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
							onClick={(e) => {
								// Keep the section or version the reader is on (anchors are the same in both languages).
								e.preventDefault();
								window.location.assign(other + window.location.hash);
							}}
						>
							<span aria-hidden="true">{otherLang.toUpperCase()}</span>
							<span className="sr-only">{otherLang === "en" ? "English" : "Español"}</span>
						</a>
						<ThemeToggle lang={lang} />
						<a
							href={IDEAS}
							className="btn btn-ghost !h-9 !px-3 ml-1.5 hidden text-[0.875rem] xl:inline-flex"
							target="_blank"
							rel="noopener noreferrer"
						>
							{t("Sugerir una idea", "Suggest an idea")}
						</a>
						<a
							href={REPO}
							className="btn btn-ghost !h-9 !px-3 ml-1.5 hidden text-[0.875rem] sm:inline-flex"
							target="_blank"
							rel="noopener noreferrer"
						>
							<GitHubIcon />
							GitHub
						</a>
						<button
							type="button"
							className="grid h-9 w-9 place-items-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text lg:hidden"
							aria-expanded={open}
							aria-controls="menu"
							aria-label={t("Menú", "Menu")}
							onClick={() => setOpen((o) => !o)}
						>
							<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
								<path
									d={open ? "M4 4l10 10M14 4L4 14" : "M3 6h12M3 12h12"}
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
								/>
							</svg>
						</button>
					</div>
				</div>
				<nav
					id="menu"
					aria-label={t("Secciones", "Sections")}
					className={`max-h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line lg:hidden ${open ? "block" : "hidden"}`}
				>
					<ul className="wrap flex flex-col py-2">
						{links.map((l) => (
							<li key={l.href}>
								<a
									href={l.href}
									aria-current={l.current ? "page" : undefined}
									className="menu-link"
									onClick={() => setOpen(false)}
								>
									{l.label}
								</a>
							</li>
						))}
						<li className="mt-2 border-t border-line pt-2">
							<a href={IDEAS} className="menu-link" target="_blank" rel="noopener noreferrer">
								{t("Sugerir una idea", "Suggest an idea")}
							</a>
						</li>
						<li>
							<a href={REPO} className="menu-link" target="_blank" rel="noopener noreferrer">
								GitHub
							</a>
						</li>
					</ul>
				</nav>
			</header>
			{/* Behind the open menu: dims the page; a tap on it closes the menu (the outside-pointer handler). */}
			{open ? (
				<div
					aria-hidden="true"
					className="fixed inset-x-0 top-16 bottom-0 z-40 bg-bg/70 backdrop-blur-sm lg:hidden"
				/>
			) : null}
		</>
	);
}
