"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Lang, num, tr } from "@/lib/i18n";

type Access = "all" | "free" | "key" | "optin";
interface State {
	q: string;
	a: Access;
	g: string;
	r: string;
}
const EMPTY: State = { q: "", a: "all", g: "", r: "" };
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The catalogue's filter. The list itself is plain server-rendered HTML (every source is there without JavaScript);
 * this only hides rows that don't match, updates the counts, and keeps the filter in the address so it can be shared.
 */
export function SourceFilter({
	lang,
	total,
	groups,
	states,
}: {
	lang: Lang;
	total: number;
	groups: { slug: string; name: string }[];
	states: { iso: string; name: string; n: number }[];
}) {
	const t = tr(lang);
	const [f, setF] = useState<State>(EMPTY);
	const [shown, setShown] = useState(total);
	const ready = useRef(false);

	// From the address once (?q=&acceso=&grupo=&estado=).
	useEffect(() => {
		const p = new URLSearchParams(window.location.search);
		const a = p.get("acceso");
		setF({
			q: p.get("q") ?? "",
			a: a === "free" || a === "key" || a === "optin" ? a : "all",
			g: groups.some((g) => g.slug === p.get("grupo")) ? (p.get("grupo") ?? "") : "",
			r: states.some((s) => s.iso === p.get("estado")) ? (p.get("estado") ?? "") : "",
		});
		ready.current = true;
	}, [groups, states]);

	useEffect(() => {
		const root = document.getElementById("catalogo");
		if (!root) return;
		const terms = fold(f.q).split(/\s+/).filter(Boolean);
		// What a row is searched by: its visible text and its licence (the title of its type), folded once.
		for (const li of root.querySelectorAll<HTMLElement>(".src")) {
			if (li.dataset.q !== undefined) continue;
			const licence = li.querySelector("[title]")?.getAttribute("title") ?? "";
			li.dataset.q = fold(`${li.textContent ?? ""} ${licence}`);
		}
		let all = 0;
		for (const section of root.querySelectorAll<HTMLElement>(".src-group")) {
			const inGroup = !f.g || section.dataset.g === f.g;
			let n = 0;
			for (const li of section.querySelectorAll<HTMLElement>(".src")) {
				const ok =
					inGroup &&
					(f.a === "all" || li.dataset.a === f.a) &&
					(!f.r || li.dataset.r === f.r) &&
					terms.every((w) => (li.dataset.q ?? "").includes(w));
				li.hidden = !ok;
				if (ok) n++;
			}
			section.hidden = n === 0;
			const count = section.querySelector("[data-shown]");
			if (count) count.textContent = num(lang, n);
			all += n;
		}
		document.getElementById("sin-resultados")?.classList.toggle("hidden", all > 0);
		setShown(all);
		for (const p of document.querySelectorAll<SVGPathElement>("[data-state]"))
			p.classList.toggle("on", p.dataset.state === f.r);
		if (!ready.current) return;
		const p = new URLSearchParams();
		if (f.q) p.set("q", f.q);
		if (f.a !== "all") p.set("acceso", f.a);
		if (f.g) p.set("grupo", f.g);
		if (f.r) p.set("estado", f.r);
		const qs = p.toString();
		history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
	}, [f, lang]);

	const bar = useRef<HTMLDivElement>(null);
	const toList = useCallback(() => {
		bar.current?.scrollIntoView({
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		});
	}, []);

	// A click on a state in the map filters by it (the state list below is the keyboard route).
	useEffect(() => {
		const paths = [...document.querySelectorAll<SVGPathElement>("[data-state]")];
		const on = (e: Event) => {
			const iso = (e.currentTarget as SVGPathElement).dataset.state ?? "";
			setF((x) => ({ ...x, g: "", r: x.r === iso ? "" : iso }));
			toList();
		};
		for (const p of paths) p.addEventListener("click", on);
		return () => {
			for (const p of paths) p.removeEventListener("click", on);
		};
	}, [toList]);

	const active = f.q !== "" || f.a !== "all" || f.g !== "" || f.r !== "";
	const access: [Access, string][] = [
		["all", t("Todas", "All")],
		["free", t("Sin clave", "No key")],
		["key", t("Con clave", "Key")],
		["optin", t("Opcionales", "Opt-in")],
	];
	return (
		<div ref={bar} className="filter-bar scroll-mt-20 lg:sticky lg:top-16 lg:z-30">
			<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
				<label className="search">
					<span className="sr-only">{t("Buscar fuentes", "Search sources")}</span>
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
						<circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.6" />
						<path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
					</svg>
					<input
						type="search"
						value={f.q}
						onChange={(e) => setF({ ...f, q: e.target.value })}
						placeholder={t("Medio, organismo, país, estado…", "Outlet, agency, country, state…")}
						autoComplete="off"
						spellCheck={false}
					/>
				</label>
				<div className="grid grid-cols-2 gap-2 lg:flex lg:items-center">
					<label className="select">
						<span className="sr-only">{t("Grupo", "Group")}</span>
						<select value={f.g} onChange={(e) => setF({ ...f, g: e.target.value })}>
							<option value="">{t("Todos los grupos", "All groups")}</option>
							{groups.map((g) => (
								<option key={g.slug} value={g.slug}>
									{g.name}
								</option>
							))}
						</select>
					</label>
					<label className="select">
						<span className="sr-only">{t("Estado", "State")}</span>
						<select value={f.r} onChange={(e) => setF({ ...f, r: e.target.value })}>
							<option value="">{t("Todos los estados", "All states")}</option>
							{states.map((s) => (
								<option key={s.iso} value={s.iso}>
									{s.name} ({num(lang, s.n)})
								</option>
							))}
						</select>
					</label>
					<fieldset className="segmented col-span-2">
						<legend className="sr-only">{t("Acceso", "Access")}</legend>
						{access.map(([id, label]) => (
							<button key={id} type="button" aria-pressed={f.a === id} onClick={() => setF({ ...f, a: id })}>
								{label}
							</button>
						))}
					</fieldset>
				</div>
				<div className="flex items-center gap-3 lg:ml-auto">
					<p className="data whitespace-nowrap text-[0.8125rem] text-text-2" aria-live="polite">
						{t(`${num(lang, shown)} de ${num(lang, total)}`, `${num(lang, shown)} of ${num(lang, total)}`)}
					</p>
					{active ? (
						<button type="button" className="clear" onClick={() => setF(EMPTY)}>
							{t("Limpiar", "Clear")}
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}
