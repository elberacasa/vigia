import { int } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { bucketLabel } from "./labels.ts";
import { BUCKETS, type Bucket, type BucketCounts } from "./model.ts";

/**
 * Every feed's health as one stacked bar plus a legend of counts. Shared by /fuentes and /estado. With `onPick`, the
 * legend entries filter (the active one is pressed); without it they are plain text.
 */
export function HealthBar({
	counts,
	active = null,
	onPick,
	compact = false,
}: {
	counts: BucketCounts;
	active?: Bucket | null;
	onPick?: (b: Bucket) => void;
	compact?: boolean;
}) {
	const l = lang.value;
	const total = BUCKETS.reduce((s, b) => s + counts[b], 0);
	const shown = BUCKETS.filter((b) => counts[b] > 0 || b === "live" || b === "failing");
	return (
		<div class={`hbar${compact ? " hbar--compact" : ""}`}>
			<div
				class="hbar__track"
				role="img"
				aria-label={shown.map((b) => `${int(counts[b], l)} ${bucketLabel(b, l).toLowerCase()}`).join(", ")}
			>
				{total > 0
					? BUCKETS.filter((b) => counts[b] > 0).map((b) => (
							<span
								key={b}
								class={`hbar__seg hbar__seg--${b}${active && active !== b ? " is-dim" : ""}`}
								style={{ flexGrow: counts[b] }}
							/>
						))
					: null}
			</div>
			<ul class="hbar__legend">
				{shown.map((b) => {
					const body = (
						<>
							<span class={`hbar__key hbar__key--${b}`} aria-hidden="true" />
							<span class="hbar__n mono">{int(counts[b], l)}</span>
							<span class="hbar__label">{bucketLabel(b, l)}</span>
						</>
					);
					return (
						<li key={b}>
							{onPick ? (
								<button
									type="button"
									class="hbar__item"
									aria-pressed={active === b}
									onClick={() => onPick(b)}
									title={t(`Mostrar solo: ${bucketLabel(b, l)}`, `Show only: ${bucketLabel(b, l)}`)}
								>
									{body}
								</button>
							) : (
								<span class="hbar__item">{body}</span>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
