import { addStyles } from "../lib/css.ts";
import { health, meta, now, panels } from "../lib/data.ts";
import { ago, int } from "../lib/format.ts";
import { lang, t } from "../lib/i18n.ts";
import { link } from "../lib/router.ts";
import { DiscrepancyNote, type MoneyView } from "../panels/Money.tsx";
import pagesCss from "../styles/pages.css?inline";
import panelsCss from "../styles/panels.css?inline";
import "../ui/atlas/style.ts";
import { HealthBar } from "../ui/atlas/HealthBar.tsx";
import { categoryLabel } from "../ui/atlas/labels.ts";
import { bucketOf, CATEGORY_ORDER, emptyCounts } from "../ui/atlas/model.ts";
import { every } from "../ui/atlas/time.ts";
import { StateBadge } from "../ui/Source.tsx";

addStyles(panelsCss);
addStyles(pagesCss);

/** Groups in the atlas's category order; a category the client does not know yet goes last. */
function rank(c: string): number {
	const i = (CATEGORY_ORDER as readonly string[]).indexOf(c);
	return i === -1 ? CATEGORY_ORDER.length : i;
}

/** Public status page: every feed, its state, freshness, budget, error and success rate. */
export function StatusPage() {
	const l = lang.value;
	const byId = new Map(health.value.map((h) => [h.id, h]));
	const byCategory = new Map<string, typeof meta.value>();
	for (const m of meta.value) {
		const c = m.category?.[0] ?? m.layer;
		byCategory.set(c, [...(byCategory.get(c) ?? []), m]);
	}
	const groups = [...byCategory.entries()].sort(([a], [b]) => rank(a) - rank(b));
	const counts = emptyCounts();
	for (const h of health.value) counts[bucketOf(h.state)]++;
	// The official rate's two routes (bcv.org.ve and bcv-api) disagreeing is a feed problem too: say it here.
	const money = panels.value.money as MoneyView | undefined;
	const discrepancies = money
		? [...(money.official.usd.discrepancies ?? []), ...(money.official.eur.discrepancies ?? [])]
		: [];
	return (
		<main class="page">
			<header class="page__head">
				<p class="caps page__kicker">{t("Estado de las fuentes", "Feed status")}</p>
				<h1 class="page__title">{t("¿Qué tan frescos están los datos?", "How fresh is the data?")}</h1>
				<p class="page__lede">
					{t(
						"Cada fuente tiene un presupuesto de frescura. Si una fuente no responde, Vigía sigue mostrando el último dato bueno con su edad y lo marca con retraso.",
						"Every feed has a freshness budget. If a source stops answering, Vigía keeps showing the last good value with its age and marks it delayed.",
					)}
				</p>
				<div class="status-summary status-summary--bar">
					<HealthBar counts={counts} compact />
					<a class="link" {...link("sources")}>
						{t("Ver el atlas de fuentes", "Open the sources atlas")} →
					</a>
				</div>
			</header>
			{discrepancies.length ? (
				<section class="status-group" aria-labelledby="status-discrepancy">
					<h2 class="status-group__title" id="status-discrepancy">
						{t("Tasa oficial: las dos vías no coinciden", "Official rate: the two routes disagree")}
					</h2>
					{discrepancies.map((d) => (
						<DiscrepancyNote key={`${d.currency}-${d.valueDate}`} d={d} />
					))}
				</section>
			) : null}
			{groups.map(([category, feeds]) => (
				<section class="status-group" key={category}>
					<h2 class="status-group__title">
						{categoryLabel(category, l)} <span class="mono">{int(feeds.length, l)}</span>
					</h2>
					<div class="table-wrap">
						<table class="status-table">
							<thead>
								<tr>
									<th scope="col">{t("Fuente", "Feed")}</th>
									<th scope="col">{t("Estado", "State")}</th>
									<th scope="col">{t("Último dato", "Newest datum")}</th>
									<th scope="col">{t("Última consulta", "Last fetch")}</th>
									<th scope="col">{t("Frecuencia", "Interval")}</th>
									<th scope="col">{t("Éxito", "Success")}</th>
								</tr>
							</thead>
							<tbody>
								{feeds.map((m) => {
									const h = byId.get(m.id);
									return (
										<tr key={m.id}>
											<th scope="row">
												<a
													class="status-table__name"
													href={m.homepage}
													target="_blank"
													rel="noopener noreferrer"
												>
													{m.name[l]}
												</a>
												<span class="note">
													{m.provider} · {m.licence.name}
												</span>
												{h?.lastError && h.state !== "ok" ? (
													<span class="status-table__error">{h.lastError}</span>
												) : null}
											</th>
											<td>{h ? <StateBadge state={h.state} /> : null}</td>
											<td class="data">
												{h?.newestObservedAt ? ago(now.value - h.newestObservedAt, l) : "—"}
											</td>
											<td class="data">{h?.lastSuccessAt ? ago(now.value - h.lastSuccessAt, l) : "—"}</td>
											<td class="data">{every(m.intervalMs, l)}</td>
											<td class="data">
												{h?.successRate !== null && h?.successRate !== undefined
													? `${int(h.successRate * 100, l)} %`
													: "—"}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</section>
			))}
		</main>
	);
}
