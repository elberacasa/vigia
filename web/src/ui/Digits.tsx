import { signal } from "@preact/signals";
import { useRef } from "preact/hooks";
import { diffGlyphs, type Glyph } from "../lib/digits.ts";
import { t } from "../lib/i18n.ts";
import { isPanelId, reveal } from "../lib/layout.ts";
import { freshCount } from "../lib/seen.ts";

/**
 * Live marks that move only when data moves.
 *
 * <Digits>: a figure whose changed characters roll (split-flap style) when its underlying value changes, e.g. the
 * BCV rate ticking over at 4 pm. Nothing moves on first paint, on a language switch (formatting only) or when a
 * refresh brings the same value. Screen readers hear "Dólar BCV: 855,66 Bs, antes 853,50" once, through one
 * page-level live region (<Announcer>), not from inside the tile's link.
 *
 * <NewTag>: the "NUEVO" micro-tag for rows that just arrived (see lib/seen.ts); <NewPill>: "2 nuevos" for a panel
 * header (Panel's `extra` slot), which scrolls to the first new row.
 */

const said = signal("");
let queue: string[] = [];
/** When each figure was last announced: one figure speaks at most once a minute (review 3, M11: noisy polls). */
const lastSaid = new Map<string, number>();
const MIN_GAP_MS = 60_000;

function announce(label: string, text: string): void {
	const at = Date.now();
	if (at - (lastSaid.get(label) ?? 0) < MIN_GAP_MS) return;
	lastSaid.set(label, at);
	if (!queue.length)
		queueMicrotask(() => {
			said.value = queue.join(". ");
			queue = [];
		});
	queue.push(text);
}

/** Mount once per page (it is inside <Palette>). */
export function Announcer() {
	return (
		<p class="sr-only" aria-live="polite" aria-atomic="true">
			{said.value}
		</p>
	);
}

interface Memory {
	raw: number | null;
	value: string;
	glyphs: Glyph[] | null;
	gen: number;
}

export function Digits(props: {
	/** The formatted figure, e.g. "853,50". */
	value: string;
	/** The number behind it: rolling happens only when this changes from one real value to another. */
	raw: number | null | undefined;
	/** What the figure is, for the announcement ("Dólar BCV"). */
	label: string;
	unit?: string;
	/**
	 * True only for figures whose change is news to a screen-reader user: rates and anomaly counts (the dollar, states
	 * with a drop, alerts). Counts that tick on every poll (headlines, heat spots) stay silent. Default false.
	 */
	announce?: boolean;
}) {
	const raw = props.raw ?? null;
	const mem = useRef<Memory>({ raw, value: props.value, glyphs: null, gen: 0 }).current;
	if (raw !== mem.raw) {
		if (mem.raw !== null && raw !== null) {
			mem.glyphs = diffGlyphs(mem.value, props.value);
			mem.gen++;
			if (props.announce === true)
				announce(
					props.label,
					`${props.label}: ${props.value}${props.unit ? ` ${props.unit}` : ""}, ${t("antes", "before")} ${mem.value}`,
				);
		} else mem.glyphs = null;
		mem.raw = raw;
	} else if (props.value !== mem.value) {
		// Same number, new formatting (language switch): no motion.
		mem.glyphs = null;
	}
	mem.value = props.value;

	if (!mem.glyphs) return <span class="digits">{props.value}</span>;
	return (
		<span class="digits digits--changed" key={mem.gen}>
			{mem.glyphs.map((g, i) =>
				g.was === null ? (
					<span class="dg" key={i}>
						{g.ch}
					</span>
				) : (
					<span class="dg dg--roll" key={i} style={{ "--d": `${g.order * 30}ms` }}>
						{g.was ? (
							<span class="dg__was" aria-hidden="true">
								{g.was}
							</span>
						) : null}
						<span class="dg__now">{g.ch}</span>
					</span>
				),
			)}
		</span>
	);
}

export function NewTag() {
	return <span class="new-tag">{t("nuevo", "new")}</span>;
}

export function NewPill({ scope, panel, onOpen }: { scope: string; panel: string; onOpen?: () => void }) {
	const n = freshCount(scope);
	if (!n) return null;
	return (
		<button
			type="button"
			class="new-pill"
			onClick={() => {
				// Open the panel (and the tab holding the rows) first, then bring the first new row into view.
				if (isPanelId(panel)) reveal(panel);
				onOpen?.();
				requestAnimationFrame(() =>
					requestAnimationFrame(() => {
						document.querySelector(`#${CSS.escape(panel)} .is-new`)?.scrollIntoView({
							block: "center",
							behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
						});
					}),
				);
			}}
		>
			{n === 1 ? t("1 nuevo", "1 new") : t(`${n} nuevos`, `${n} new`)}
		</button>
	);
}
