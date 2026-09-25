import { int } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";
import { categoryLabel, categoryNote } from "./labels.ts";
import { BUCKETS, type Group } from "./model.ts";

/**
 * One tile per category (each feed counted once, under its primary category): count, publishers, share of the whole
 * catalogue and a health strip. A grid rather than a treemap: with hundreds of outlets next to two airspace feeds, a
 * treemap leaves the small categories unreadable. Tiles filter the catalogue.
 */
export function CategoryGrid({
	groups,
	total,
	active,
	onPick,
}: {
	groups: readonly Group[];
	total: number;
	active: string | null;
	onPick: (id: string) => void;
}) {
	const l = lang.value;
	const top = Math.max(1, ...groups.map((g) => g.feeds));
	return (
		<ul class="cgrid">
			{groups.map((g) => {
				const share = total > 0 ? g.feeds / total : 0;
				const pressed = active === g.key;
				return (
					<li key={g.key}>
						<button
							type="button"
							class={`cgrid__tile${pressed ? " is-on" : ""}${active && !pressed ? " is-dim" : ""}`}
							aria-pressed={pressed}
							onClick={() => onPick(g.key)}
						>
							<span class="cgrid__name">{categoryLabel(g.key, l)}</span>
							<span class="cgrid__n">{int(g.feeds, l)}</span>
							<span class="cgrid__sub note">
								{t(
									`${int(g.publishers, l)} ${g.publishers === 1 ? "publicador" : "publicadores"} · ${pct(share)}`,
									`${int(g.publishers, l)} ${g.publishers === 1 ? "publisher" : "publishers"} · ${pct(share)}`,
								)}
							</span>
							<span class="cgrid__note">{categoryNote(g.key, l)}</span>
							<span class="cgrid__bar" aria-hidden="true">
								<span class="cgrid__fill" style={{ width: `${(g.feeds / top) * 100}%` }}>
									{BUCKETS.filter((b) => g.buckets[b] > 0).map((b) => (
										<span key={b} class={`hbar__seg hbar__seg--${b}`} style={{ flexGrow: g.buckets[b] }} />
									))}
								</span>
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function pct(share: number): string {
	if (share > 0 && share < 0.01) return "<1 %";
	return `${Math.round(share * 100)} %`;
}
