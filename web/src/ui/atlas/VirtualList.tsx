import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const OVERSCAN = 6;
/** The window moves in steps of this many rows, so most scroll frames change nothing and render nothing. */
const STEP = 8;

/**
 * A list that renders only the rows near the viewport, scrolled by the page itself (no inner scroll box, so it
 * feels native on a phone). Rows have one fixed height, set by the caller and enforced in CSS.
 */
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
			const first = Math.floor(-top / rowHeight) - OVERSCAN;
			const last = Math.ceil((innerHeight - top) / rowHeight) + OVERSCAN;
			const start = Math.max(0, Math.floor(first / STEP) * STEP);
			const end = Math.min(n, Math.ceil(last / STEP) * STEP);
			setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, Math.max(start, end)]));
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(update);
		};
		update();
		addEventListener("scroll", schedule, { passive: true });
		addEventListener("resize", schedule);
		return () => {
			removeEventListener("scroll", schedule);
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
