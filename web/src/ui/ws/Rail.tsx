import { lang, t } from "../../lib/i18n.ts";
import { MODULES, type ModuleDef } from "../../lib/modules.ts";
import { link, moduleId, moduleLink, route } from "../../lib/router.ts";
import { summarize } from "../../lib/summary.ts";

/** A module's worst summary tone, so the rail marks where something is not normal (a shape, never colour alone). */
function moduleTone(m: ModuleDef): "warn" | "alert" | null {
	let worst: "warn" | "alert" | null = null;
	for (const id of m.columns.flat()) {
		const tone = summarize(id)?.tone;
		if (tone === "alert") return "alert";
		if (tone === "warn") worst = "warn";
	}
	return worst;
}

/** Rail labels where the module's name is longer than the rail. */
const SHORT: Partial<Record<string, { es: string; en: string }>> = {
	tierra: { es: "Tierra", en: "Earth" },
	humanitario: { es: "Humanitario", en: "Humanitarian" },
};

function Icon({ d }: { d: string }) {
	return (
		<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" class="ico rail__icon">
			<path d={d} />
		</svg>
	);
}

const PAGES = [
	{
		route: "brief" as const,
		es: "Resumen",
		en: "Brief",
		d: "M5 2.5h7.5L15 5v12.5H5ZM7.5 8h5M7.5 11h5M7.5 14h3",
	},
	{
		route: "sources" as const,
		es: "Fuentes",
		en: "Sources",
		d: "M4 5.5c0-1.7 2.7-3 6-3s6 1.3 6 3-2.7 3-6 3-6-1.3-6-3Zm0 0v9c0 1.7 2.7 3 6 3s6-1.3 6-3v-9M4 10c0 1.7 2.7 3 6 3s6-1.3 6-3",
	},
	{
		route: "status" as const,
		es: "Estado",
		en: "Status",
		d: "M2.5 10h3l2-5 3.5 10 2.5-6.5 1.2 1.5h2.8",
	},
	{
		route: "guide" as const,
		es: "Claves",
		en: "Keys",
		d: "M8 11.5a3.5 3.5 0 1 1 2.8-1.4l6.2 6.2M13.5 13.5l1.8-1.8M11.8 11.8l1.4-1.4",
	},
];

/** The left rail: every module (with its number key), then the pages about the data itself. */
export function Rail() {
	const l = lang.value;
	const r = route.value;
	return (
		<nav class="rail" aria-label={t("Módulos", "Modules")}>
			<ul class="rail__list">
				{MODULES.map((m) => {
					const current = r === "wall" && moduleId.value === m.id;
					const tone = moduleTone(m);
					const name = l === "es" ? m.es : m.en;
					return (
						<li key={m.id}>
							<a
								{...moduleLink(m.id)}
								class={`rail__item${current ? " is-current" : ""}`}
								aria-current={current ? "page" : undefined}
								title={`${name} · ${l === "es" ? m.qEs : m.qEn} (${m.key})`}
							>
								<Icon d={m.icon} />
								<span class="rail__label">{SHORT[m.id]?.[l] ?? name}</span>
								<span class="rail__key mono">{m.key}</span>
								{tone ? (
									<span class={`rail__flag rail__flag--${tone}`}>
										<span class="sr-only">
											{tone === "alert" ? t("(alerta)", "(alert)") : t("(aviso)", "(notice)")}
										</span>
									</span>
								) : null}
							</a>
						</li>
					);
				})}
			</ul>
			<ul class="rail__list rail__list--pages">
				{PAGES.map((p) => {
					const current = r === p.route;
					return (
						<li key={p.route}>
							<a
								{...link(p.route)}
								class={`rail__item rail__item--page${current ? " is-current" : ""}`}
								aria-current={current ? "page" : undefined}
								title={t(p.es, p.en)}
							>
								<Icon d={p.d} />
								<span class="rail__label">{t(p.es, p.en)}</span>
							</a>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
