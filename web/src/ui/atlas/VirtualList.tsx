import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const OVERSCAN = 6;
/** The window moves in steps of this many rows, so most scroll frames change nothing and render nothing. */
const STEP = 8;

/**
 * A list that renders only the rows near the viewport, scrolled by whatever scrolls it (no inner scroll box of its
 * own, so it feels native on a phone). On a phone that is the page; on the desk it is the workstation's `.ws__page`,
 * whose scroll events never reach `window` (whole-release review, B4: the desk's Fuentes showed no row at all). So the
 * visible band is the viewport clipped to the nearest scrolling ancestor, and scroll is heard in the capture phase,
 * from any element. Rows have one fixed height, set by the caller and enforced in CSS.
 */

/** The nearest ancestor that scrolls vertically; null when the page itself does. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
	for (let p = el?.parentElement ?? null; p && p !== document.body; p = p.parentElement) {
		const y = getComputedStyle(p).overflowY;
		if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
	}
	return null;
}

/** Rows [start, end) to render for a list whose top is at `top`, seen through the band [viewTop, viewBottom). */
export function visibleRange(
	top: number,
	viewTop: number,
	viewBottom: number,
	rowHeight: number,
	n: number,
): [number, number] {
	const first = Math.floor((viewTop - top) / rowHeight) - OVERSCAN;
	const last = Math.ceil((viewBottom - top) / rowHeight) + OVERSCAN;
	const start = Math.min(n, Math.max(0, Math.floor(first / STEP) * STEP));
	const end = Math.min(n, Math.ceil(last / STEP) * STEP);
	return [start, Math.max(start, end)];
}
export function VirtualList<T>({
	items,
	rowHeight,
	render,
	keyOf,
	label,
}: {
	items: readonly T[];
	keyOf: (item: T) => string;
	rowHeight: number;
	render: (item: T, index: number) => ComponentChildren;
	label: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [range, setRange] = useState<[number, number]>([0, 24]);
	const n = items.length;
	useEffect(() => {
		let raf = 0;
		const update = () => {
			raf = 0;
			const el = ref.current;
			if (!el) return;
			const top = el.getBoundingClientRect().top;
			const box = scrollParent(el)?.getBoundingClientRect();
			const [start, end] = visibleRange(
				top,
				Math.max(0, box?.top ?? 0),
				Math.min(innerHeight, box?.bottom ?? innerHeight),
				rowHeight,
				n,
			);
			setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(update);
		};
		update();
		// Capture: a scroll inside any element (the desk's .ws__page) is heard here too.
		addEventListener("scroll", schedule, { passive: true, capture: true });
		addEventListener("resize", schedule);
		return () => {
			removeEventListener("scroll", schedule, { capture: true });
			removeEventListener("resize", schedule);
			if (raf) cancelAnimationFrame(raf);
		};
	}, [n, rowHeight]);
	const [start, end] = range;
	const slice = items.slice(start, end);
	return (
		<div ref={ref} class="vlist" style={{ height: `${n * rowHeight}px` }}>
			<ul
				class="vlist__window"
				aria-label={label}
				style={{ transform: `translateY(${start * rowHeight}px)` }}
			>
				{slice.map((item, i) => (
					<li
						aria-setsize={n}
						aria-posinset={start + i + 1}
						class="vlist__row"
						style={{ height: `${rowHeight}px` }}
						key={keyOf(item)}
					>
						{render(item, start + i)}
					</li>
				))}
			</ul>
		</div>
	);
}
