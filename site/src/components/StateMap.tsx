import { sources } from "@/lib/catalog";
import { type Lang, num, tr } from "@/lib/i18n";

/**
 * Venezuela's states (the app's own outlines, simplified at build time), shaded by how many regional outlets Vigía
 * reads in each. On /fuentes a click on a state filters the catalogue (SourceFilter reads `data-state`); the state
 * list in the filter bar is the keyboard route to the same thing.
 */
export function StateMap({ lang, className = "" }: { lang: Lang; className?: string }) {
	const t = tr(lang);
	const { states, frame } = sources;
	const max = Math.max(...states.map((s) => s.outlets));
	const ranked = states.filter((s) => s.outlets > 0).sort((a, b) => b.outlets - a.outlets);
	const label = t(
		`Medios regionales por estado: ${ranked.map((s) => `${s.name} ${s.outlets}`).join(", ")}.`,
		`Regional outlets by state: ${ranked.map((s) => `${s.name} ${s.outlets}`).join(", ")}.`,
	);
	return (
		<svg
			viewBox={`0 0 ${frame.width} ${frame.height}`}
			className={`state-map h-auto w-full ${className}`}
			role="img"
			aria-label={label}
		>
			{states.map((s) => (
				<path
					key={s.iso}
					d={s.d}
					data-state={s.outlets > 0 ? s.iso : undefined}
					className={s.outlets > 0 ? "has" : "none"}
					style={s.outlets > 0 ? { fillOpacity: 0.22 + 0.68 * (s.outlets / max) } : undefined}
				>
					<title>
						{s.outlets > 0
							? `${s.name}: ${num(lang, s.outlets)} ${s.outlets === 1 ? t("medio", "outlet") : t("medios", "outlets")}`
							: `${s.name}: ${t("ninguno aún", "none yet")}`}
					</title>
				</path>
			))}
			{states
				.filter((s) => s.outlets > 0 && !s.small)
				.map((s) => (
					<text key={s.iso} x={s.label[0]} y={s.label[1]} className="state-map__n">
						{s.outlets}
					</text>
				))}
		</svg>
	);
}
