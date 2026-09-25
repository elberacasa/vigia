"use client";

import { useEffect, useRef, useState } from "react";
import { type Lang, REPO, tr } from "@/lib/i18n";
import { Mark, Wordmark } from "./Brand";
import { GitHubIcon } from "./Icons";
import { ThemeToggle } from "./ThemeToggle";

export function Header({ lang }: { lang: Lang }) {
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
		window.addEventListener("keydown", esc);
		document.addEventListener("pointerdown", outside);
		return () => {
			window.removeEventListener("keydown", esc);
			document.removeEventListener("pointerdown", outside);
		};
	}, [open]);

	const links = [
		["#que-muestra", t("Qué muestra", "What it shows")],
		["#principios", t("Principios", "Principles")],
		["#instalar", t("Instalar", "Install")],
		["#desarrolladores", t("Desarrolladores", "Developers")],
	] as const;
	const other =
		lang === "es"
			? { href: "/en", label: "EN", name: "English" }
			: { href: "/", label: "ES", name: "Español" };

	return (
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
					href={lang === "es" ? "/" : "/en"}
					className="flex items-center gap-2.5 rounded-md"
					aria-label={t("Vigía, inicio", "Vigía, home")}
				>
					<Mark size={30} />
					<Wordmark height={14} label={false} />
				</a>
				<nav aria-label={t("Secciones", "Sections")} className="hidden flex-1 md:block">
					<ul className="flex items-center gap-1">
						{links.map(([href, label]) => (
							<li key={href}>
								<a
									href={href}
									className="whitespace-nowrap rounded-md px-3 py-2 text-[0.875rem] text-text-2 transition-colors hover:text-text"
								>
									{label}
								</a>
							</li>
						))}
					</ul>
				</nav>
				<div className="ml-auto flex items-center gap-1.5 md:ml-0">
					<a
						href={other.href}
						hrefLang={other.href === "/en" ? "en" : "es"}
						lang={other.href === "/en" ? "en" : "es"}
						className="data grid h-9 min-w-9 place-items-center rounded-md px-2 text-[0.8125rem] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
						onClick={(e) => {
							// Keep the section the reader is on.
							e.preventDefault();
							window.location.assign(other.href + window.location.hash);
						}}
					>
						<span aria-hidden="true">{other.label}</span>
						<span className="sr-only">{other.name}</span>
					</a>
					<ThemeToggle lang={lang} />
					<a
						href={REPO}
						className="btn btn-ghost !h-9 !px-3 ml-1.5 hidden text-[0.875rem] sm:inline-flex"
						rel="noopener"
					>
						<GitHubIcon />
						GitHub
					</a>
					<button
						type="button"
						className="grid h-9 w-9 place-items-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text md:hidden"
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
				className={`border-t border-line md:hidden ${open ? "block" : "hidden"}`}
			>
				<ul className="wrap flex flex-col py-2">
					{links.map(([href, label]) => (
						<li key={href}>
							<a
								href={href}
								className="block rounded-md py-3 text-[1.0625rem] text-text"
								onClick={() => setOpen(false)}
							>
								{label}
							</a>
						</li>
					))}
					<li>
						<a href={REPO} className="block rounded-md py-3 text-[1.0625rem] text-text" rel="noopener">
							GitHub
						</a>
					</li>
				</ul>
			</nav>
		</header>
	);
}
