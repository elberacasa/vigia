"use client";

import { useEffect } from "react";

const DURATION = 1100;
const ease = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

/**
 * Counts every `[data-count]` element (Count) up from zero the first time it scrolls into view. Elements already
 * on screen when the page loads keep their final value (no flash); the rest are set to zero only while out of view.
 * Nothing runs under reduced motion.
 */
export function CountObserver() {
	useEffect(() => {
		if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const fmt = new Intl.NumberFormat(document.documentElement.lang === "es" ? "es-VE" : "en-US");
		const seen = new WeakSet<Element>();
		const frames = new Set<number>();
		const run = (el: HTMLElement) => {
			const to = Number(el.dataset.count);
			const start = performance.now();
			const step = (now: number) => {
				const p = ease((now - start) / DURATION);
				el.textContent = fmt.format(Math.round(to * p));
				if (p < 1) frames.add(requestAnimationFrame(step));
			};
			frames.add(requestAnimationFrame(step));
		};
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					const el = e.target as HTMLElement;
					if (!seen.has(el)) {
						seen.add(el);
						if (e.isIntersecting) io.unobserve(el);
						else el.textContent = fmt.format(0);
						continue;
					}
					if (e.isIntersecting) {
						io.unobserve(el);
						run(el);
					}
				}
			},
			{ threshold: 0.2 },
		);
		for (const el of document.querySelectorAll("[data-count]")) io.observe(el);
		return () => {
			io.disconnect();
			for (const f of frames) cancelAnimationFrame(f);
		};
	}, []);
	return null;
}
