import { healthById, now, panels } from "../lib/data.ts";
import { ago, stamp } from "../lib/format.ts";
import { currentClauses, type HeadlineInput } from "../lib/headline.ts";
import { lang, t } from "../lib/i18n.ts";
import { ignoredTime, replaying, setViewTime } from "../map/view.ts";

/** One sentence, built by fixed rules from the computed panels, each clause linking to its panel. */
export function Ahora() {
	const l = lang.value;
	const clauses = currentClauses(panels.value as HeadlineInput, healthById.value, now.value, l);
	const shown = replaying.value;
	const ignored = ignoredTime.value;
	if (!clauses.length && shown === null && !ignored) return null;
	return (
		<section class={`ahora${shown !== null ? " ahora--replay" : ""}`} aria-label={t("Ahora", "Now")}>
			<span class="ahora__when">
				<span class="ahora__label">{t("Ahora", "Now")}</span>
				<span class="data">{stamp(now.value, l)}</span>
			</span>
			{shown !== null ? (
				// Not a live region: the history strip's status is the one place that announces the replay.
				<p class="ahora__replay">
					{t(
						`El mapa muestra el ${stamp(shown, l, now.value)}; esta línea y los paneles siguen en vivo.`,
						`The map shows ${stamp(shown, l, now.value)}; this line and the panels are live.`,
					)}{" "}
					<button type="button" class="link-button" onClick={() => setViewTime(null)}>
						{t("Volver a en vivo", "Back to live")}
					</button>
				</p>
			) : ignored ? (
				<p class="ahora__replay">
					{ignored.reason === "layer"
						? t(
								`El enlace pedía el ${stamp(ignored.at, l, now.value)}, pero solo la capa Internet tiene historial: el mapa está en vivo.`,
								`The link asked for ${stamp(ignored.at, l, now.value)}, but only the Internet layer has history: the map is live.`,
							)
						: t(
								`El enlace pedía el ${stamp(ignored.at, l, now.value)}, fuera del historial guardado: el mapa está en vivo.`,
								`The link asked for ${stamp(ignored.at, l, now.value)}, outside the stored history: the map is live.`,
							)}{" "}
					<button type="button" class="link-button" onClick={() => (ignoredTime.value = null)}>
						{t("Entendido", "OK")}
					</button>
				</p>
			) : null}
			<p class="ahora__text">
				{clauses.map((c, i) => (
					<>
						{i ? (
							<span class="ahora__sep" aria-hidden="true">
								{" "}
								·{" "}
							</span>
						) : null}
						<a
							href={c.href}
							class={`ahora__clause ahora__clause--${c.tone}${c.stale ? " ahora__clause--stale" : ""}`}
							key={c.text}
						>
							{c.text}
							{c.stale ? (
								<span class="ahora__stale">
									{" "}
									(
									{c.lastAt
										? `${t("dato de", "data from")} ${ago(now.value - c.lastAt, l)}`
										: t("sin actualizar", "not updated")}
									)
								</span>
							) : null}
						</a>
					</>
				))}
			</p>
		</section>
	);
}
