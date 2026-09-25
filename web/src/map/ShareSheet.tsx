import { useState } from "preact/hooks";
import { healthById, now, panels } from "../lib/data.ts";
import { clauseText, currentClauses, type HeadlineInput } from "../lib/headline.ts";
import { lang, t } from "../lib/i18n.ts";
import { shareUrl } from "../lib/router.ts";
import type { DollarCardInput, InternetCardInput, QuakesCardInput } from "../lib/share.ts";
import { stateName } from "../lib/states.ts";
import type { ConnectivityView } from "../panels/Connectivity.tsx";
import type { FiresView, WeatherView } from "../panels/Earth.tsx";
import type { NewsView } from "../panels/News.tsx";
import type { QuakesView } from "../panels/Quakes.tsx";
import type { StateFill } from "./Map.tsx";
import { selectedState } from "./view.ts";

export type CardKind = "map" | "dollar" | "internet" | "quakes" | "state";

/** The Ahora sentence as plain text (for WhatsApp and Telegram), built by the same rules as the page's line. */
export function ahoraText(): string {
	return currentClauses(panels.value as HeadlineInput, healthById.value, now.value, lang.value)
		.map((c) => clauseText(c, now.value, lang.value))
		.join(" · ");
}

/**
 * Makes one card from the current data and hands it to the share sheet (or downloads it). `map` is supplied by the map
 * panel (it knows the current shading); the rest read the panels directly. Returns false when the data is missing.
 */
export async function shareCard(kind: CardKind, mapCard?: () => Promise<Blob>): Promise<boolean> {
	const p = panels.value;
	const l = lang.value;
	const at = now.value;
	// The card templates (~6 KB gzipped) load on the first share, not with the page.
	const { cardFileName, dollarCard, internetCard, quakesCard, shareOrDownload, stateCard } = await import(
		"../lib/share.ts"
	);
	let blob: Blob | null = null;
	let name: string = kind;
	if (kind === "map" && mapCard) blob = await mapCard();
	else if (kind === "dollar" && p.money) blob = await dollarCard(p.money as DollarCardInput, at, l);
	else if (kind === "internet" && p.connectivity)
		blob = await internetCard(p.connectivity as InternetCardInput, at, l);
	else if (kind === "quakes" && p.quakes) blob = await quakesCard(p.quakes as QuakesCardInput, at, l);
	else if (kind === "state" && selectedState.value) {
		const iso = selectedState.value;
		const conn = (p.connectivity as ConnectivityView | undefined)?.states.find((s) => s.id === iso) ?? null;
		const tone: StateFill["tone"] | undefined =
			conn?.level === "drop" ? "drop" : conn?.level === "severe" ? "severe" : undefined;
		blob = await stateCard(
			{
				iso,
				name: stateName(iso),
				connectivity: conn ? { level: conn.level, headline: conn.headline } : null,
				weather: (p.weather as WeatherView | undefined)?.capitals.find((c) => c.stateIso === iso) ?? null,
				fires: (p.fires as FiresView | undefined)?.byState.find((f) => f.stateIso === iso) ?? null,
				news: (p.news as NewsView | undefined)?.byState[iso] ?? null,
				quakes: ((p.quakes as QuakesView | undefined)?.items ?? []).filter((q) => q.state === iso),
				fill: tone ? { tone } : undefined,
			},
			at,
			l,
		);
		name = stateName(iso)
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^\w]+/g, "-")
			.toLowerCase();
	}
	if (!blob) return false;
	await shareOrDownload(blob, cardFileName(name, at), "Vigía");
	return true;
}

function isLocalHost(): boolean {
	const h = location.hostname;
	return h === "localhost" || h.endsWith(".localhost") || /^127\./.test(h) || h === "[::1]";
}

/**
 * The share menu's contents (its own chunk, loaded when the menu first opens): copy the link to this exact view, the
 * image cards, and WhatsApp/Telegram links carrying the Ahora sentence. Links are plain URLs the person opens; nothing
 * is sent by Vigía.
 */
export function ShareSheet({ mapCard }: { mapCard: () => Promise<Blob> }) {
	const [busy, setBusy] = useState<CardKind | null>(null);
	const [copied, setCopied] = useState(false);
	const p = panels.value;
	const iso = selectedState.value;
	const card = (kind: CardKind, label: string, available: boolean) => (
		<li>
			<button
				type="button"
				role="menuitem"
				disabled={!available || busy !== null}
				onClick={async () => {
					setBusy(kind);
					try {
						await shareCard(kind, mapCard);
					} finally {
						setBusy(null);
					}
				}}
			>
				{busy === kind ? t("Preparando…", "Preparing…") : label}
			</button>
		</li>
	);
	const url = location.href;
	const text = ahoraText();
	return (
		<div class="share-menu__sheet" role="menu">
			<ul>
				<li>
					<button
						type="button"
						role="menuitem"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(shareUrl());
								setCopied(true);
								setTimeout(() => setCopied(false), 2_000);
							} catch {
								setCopied(false);
							}
						}}
					>
						{copied ? t("Enlace copiado ✓", "Link copied ✓") : t("Copiar enlace", "Copy link")}
					</button>
				</li>
				<li>
					<a
						role="menuitem"
						href={`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`}
						target="_blank"
						rel="noopener noreferrer"
					>
						WhatsApp
					</a>
				</li>
				<li>
					<a
						role="menuitem"
						href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`}
						target="_blank"
						rel="noopener noreferrer"
					>
						Telegram
					</a>
				</li>
			</ul>
			<p class="share-menu__title">{t("Imagen con fuentes y hora", "Image with sources and time")}</p>
			<ul>
				{card("map", t("Mapa como se ve", "Map as shown"), true)}
				{card("internet", t("Internet por estado", "Internet by state"), Boolean(p.connectivity))}
				{card("dollar", t("Dólar", "Dollar"), Boolean(p.money))}
				{card("quakes", t("Sismos", "Earthquakes"), Boolean(p.quakes))}
				{iso ? card("state", t(`Estado ${stateName(iso)}`, `${stateName(iso)} state`), true) : null}
			</ul>
			{isLocalHost() ? (
				<p class="share-menu__note note">
					{t(
						"Este Vigía corre en su equipo: el enlace solo abre aquí. Las imágenes sí se pueden compartir.",
						"This Vigía runs on your computer: the link only opens here. Images can be shared.",
					)}
				</p>
			) : null}
		</div>
	);
}
