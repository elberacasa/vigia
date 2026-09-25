"use client";

import { useEffect } from "react";

/**
 * Marks each `.reveal` element as in view the first time it enters the viewport (see Reveal). It also arms the
 * hidden starting state (the `reveal-on` class on <html>), and only once the observer has reported where everything
 * is: if this script never runs (a failed chunk, a blocker, an old browser), every section is simply visible, and
 * whatever is already on screen is marked before the class is set, so it never flashes. No layout is forced.
 */
export function RevealObserver() {
	useEffect(() => {
		if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let armed = false;
		const io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue;
				e.target.classList.add("is-in");
				io.unobserve(e.target);
			}
			// The first report covers every element: from now on, the ones still out of view wait hidden.
			if (!armed) {
				armed = true;
				document.documentElement.classList.add("reveal-on");
			}
		});
		for (const el of document.querySelectorAll<HTMLElement>(".reveal:not(.is-in)")) io.observe(el);
		return () => io.disconnect();
	}, []);
	return null;
}
