"use client";

import { useEffect, useRef, useState } from "react";
import { type Lang, num, tr, when } from "@/lib/i18n";
import type { Hover, MapData, SceneHandle } from "./map/scene";

/**
 * The hero map. First paint is a still image of the same scene (in the page's theme, sized for the screen; it is the
 * page's largest paint, so it is preloaded at high priority). The WebGL scene only adds hover, so it loads only where
 * hover exists and the device can afford it: a wide screen with a mouse, no reduced-motion preference, no Save-Data,
 * WebGL available, at least 4 cores and (where the browser says) 4 GB of memory; and only once the map is on screen
 * and the page is idle. Everywhere else (every phone) the still stays.
 */
function capable(): boolean {
	if (!matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)").matches) return false;
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
	const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
	if (nav.connection?.saveData) return false;
	if ((nav.hardwareConcurrency ?? 4) < 4) return false;
	if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
	try {
		const c = document.createElement("canvas");
		return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
	} catch {
		return false;
	}
}

const idle = (fn: () => void) =>
	"requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1200);

/** The still in both themes: srcset strings of the 640/960/1280-wide captures, and the fallback src. */
export interface Stills {
	dark: { src: string; srcSet: string };
	light: { srcSet: string };
	sizes: string;
}

export function HeroMap({ lang, alt, stills }: { lang: Lang; alt: string; stills: Stills }) {
	const host = useRef<HTMLDivElement>(null);
	const [live, setLive] = useState(false);
	const [hover, setHover] = useState<Hover | null>(null);
	const [data, setData] = useState<MapData | null>(null);
	const still = useRef<HTMLImageElement>(null);

	// The <picture> follows the system theme; a theme chosen on this page (data-theme) wins over it.
	useEffect(() => {
		const sync = () => {
			const img = still.current;
			const set = document.documentElement.dataset.theme;
			const source = img?.parentElement?.querySelector("source");
			if (!img || !source) return;
			if (set === "light" || set === "dark") source.media = set === "light" ? "all" : "not all";
			else source.media = "(prefers-color-scheme: light)";
		};
		sync();
		const watch = new MutationObserver(sync);
		watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => watch.disconnect();
	}, []);

	useEffect(() => {
		const el = host.current;
		if (!el || !capable()) return;
		let handle: SceneHandle | null = null;
		let cancelled = false;
		let themeWatch: MutationObserver | null = null;
		const media = matchMedia("(prefers-color-scheme: light)");
		const load = async () => {
			const [{ mount, palette }, json] = await Promise.all([
				import("./map/scene"),
				import("@/data/map.json"),
			]);
			if (cancelled) return;
			const d = json.default as unknown as MapData;
			setData(d);
			handle = mount(el, d, {
				onHover: setHover,
				onReady: () => setLive(true),
				onLost: () => setLive(false),
			});
			const repaint = () => handle?.setPalette(palette(el));
			themeWatch = new MutationObserver(repaint);
			themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
			media.addEventListener("change", repaint);
		};
		// Only once the map is on screen, then when the page is idle.
		let id: number | ReturnType<typeof setTimeout> | null = null;
		const seen = new IntersectionObserver(([e]) => {
			if (!e?.isIntersecting) return;
			seen.disconnect();
			id = idle(() => void load());
		});
		seen.observe(el);
		return () => {
			cancelled = true;
			seen.disconnect();
			if (typeof id === "number" && "cancelIdleCallback" in window) cancelIdleCallback(id);
			if (id !== null) clearTimeout(id);
			themeWatch?.disconnect();
			handle?.destroy();
		};
	}, []);

	const tip = hover && data ? describe(lang, data, hover) : null;

	return (
		<div className="relative h-full w-full [mask-image:radial-gradient(ellipse_74%_66%_at_50%_48%,black_66%,transparent)]">
			{/* The still: the same scene, rendered from this page in each theme. */}
			<picture>
				<source srcSet={stills.light.srcSet} sizes={stills.sizes} media="(prefers-color-scheme: light)" />
				<img
					ref={still}
					src={stills.dark.src}
					srcSet={stills.dark.srcSet}
					sizes={stills.sizes}
					alt={alt}
					width={1280}
					height={1040}
					fetchPriority="high"
					className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${live ? "opacity-0" : "opacity-100"}`}
				/>
			</picture>
			<div
				ref={host}
				className={`absolute inset-0 transition-opacity duration-700 ${live ? "opacity-100" : "opacity-0"}`}
				style={{ touchAction: "pan-y" }}
			/>
			{tip ? (
				<div
					role="status"
					className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-line-strong bg-surface-1/95 px-3 py-2 text-[0.8125rem] leading-snug shadow-lg backdrop-blur"
					style={{
						left: Math.min(hover?.x ?? 0, (host.current?.clientWidth ?? 400) - 260) + 14,
						top: (hover?.y ?? 0) + 14,
					}}
				>
					<div className="font-semibold text-text">{tip.title}</div>
					<div className="text-text-2">{tip.body}</div>
					<div className="data mt-1 text-[0.6875rem] text-text-3">{tip.source}</div>
				</div>
			) : null}
		</div>
	);
}

function describe(
	lang: Lang,
	data: MapData,
	h: Hover,
): { title: string; body: string; source: string } | null {
	const t = tr(lang);
	if (h.kind === "quake") {
		const q = data.live.quakes[h.index];
		if (!q) return null;
		return {
			title: `M${num(lang, q.mag, 1)} · ${t("sismo", "earthquake")}`,
			body: q.place,
			source: `${q.source} · ${when(lang, q.at, false)}`,
		};
	}
	if (h.kind === "fire") {
		const f = data.live.fires[h.index];
		if (!f) return null;
		return {
			title: t(`Foco de calor · ${num(lang, f.frpMW, 0)} MW`, `Heat detection · ${num(lang, f.frpMW, 0)} MW`),
			body: f.place,
			source: `NASA FIRMS · ${when(lang, f.at, false)}`,
		};
	}
	const s = data.states[h.index];
	if (!s) return null;
	const level = data.live.connectivity.states.find((c) => c.iso === s.iso)?.level ?? "no-data";
	const text = {
		normal: t("Internet: señal normal para esta hora", "Internet: normal signal for this hour"),
		drop: t("Internet: caída de señal", "Internet: signal drop"),
		severe: t("Internet: caída fuerte", "Internet: severe drop"),
		"no-data": t("Internet: sin datos suficientes", "Internet: not enough data"),
	}[level];
	return {
		title: s.name,
		body: text,
		source: `IODA (Georgia Tech) · ${when(lang, data.live.connectivity.asOf, false)}`,
	};
}
