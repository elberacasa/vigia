import { useEffect, useRef, useState } from "preact/hooks";
import { int, stamp } from "../../lib/format.ts";
import { lang, t } from "../../lib/i18n.ts";

const H = 88;
const PAD_T = 10;
const PAD_B = 4;

/**
 * Feeds in Vigía over time: a stepped cumulative line from each feed's date of joining (git history, generated
 * into /api/meta). Hover or focus shows the count at a moment.
 */
export function Growth({
	points,
	undated,
}: {
	points: readonly { t: number; n: number }[];
	undated: number;
}) {
	const l = lang.value;
	const box = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	const [hover, setHover] = useState<number | null>(null);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const first = points[0];
	const last = points.at(-1);
	if (!first || !last) {
		return <p class="note">{t("Sin fechas de alta todavía.", "No dates yet.")}</p>;
	}
	const t0 = first.t;
	const span = Math.max(1, last.t - t0);
	const max = Math.max(1, last.n);
	const x = (tt: number) => ((tt - t0) / span) * w;
	const y = (n: number) => PAD_T + (1 - n / max) * (H - PAD_T - PAD_B);
	let d = `M0 ${y(0)}`;
	let prev = 0;
	for (const p of points) {
		d += `L${x(p.t).toFixed(1)} ${y(prev).toFixed(1)}L${x(p.t).toFixed(1)} ${y(p.n).toFixed(1)}`;
		prev = p.n;
	}
	const area = `${d}L${w} ${y(last.n).toFixed(1)}L${w} ${H}L0 ${H}Z`;
	const short = span < 2 * 86_400_000;
	const fmt = (tt: number) => (short ? stamp(tt, l) : stamp(tt, l).split(",")[0]);
	const hp = hover !== null ? points[hover] : null;

	const pick = (clientX: number) => {
		const el = box.current;
		if (!el || w === 0) return;
		const px = clientX - el.getBoundingClientRect().left;
		const tt = t0 + (px / w) * span;
		let i = 0;
		for (let k = 0; k < points.length; k++) if ((points[k]?.t ?? 0) <= tt) i = k;
		setHover(i);
	};

	return (
		<figure class="growth">
			<figcaption class="growth__head">
				<span class="caps">{t("Fuentes añadidas", "Sources added")}</span>
				<span class="growth__read mono" aria-live="polite">
					{hp ? `${int(hp.n, l)} · ${fmt(hp.t)}` : `${int(last.n, l)} · ${t("ahora", "now")}`}
				</span>
			</figcaption>
			<div
				class="growth__plot"
				ref={box}
				role="slider"
				tabIndex={0}
				aria-label={t("Fuentes en Vigía a lo largo del tiempo", "Sources in Vigía over time")}
				aria-valuemin={0}
				aria-valuemax={last.n}
				aria-valuenow={hp?.n ?? last.n}
				aria-valuetext={hp ? `${hp.n}, ${fmt(hp.t)}` : `${last.n}`}
				onPointerMove={(e) => pick(e.clientX)}
				onPointerLeave={() => setHover(null)}
				onKeyDown={(e) => {
					if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
					e.preventDefault();
					const cur = hover ?? points.length - 1;
					setHover(Math.max(0, Math.min(points.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1))));
				}}
				onBlur={() => setHover(null)}
			>
				{w > 0 ? (
					<svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
						<line class="growth__base" x1={0} x2={w} y1={H - PAD_B} y2={H - PAD_B} />
						<path class="growth__area" d={area} />
						<path class="growth__line" d={`${d}L${w} ${y(last.n).toFixed(1)}`} />
						{hp ? (
							<>
								<line class="growth__cross" x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={H} />
								<circle class="growth__dot" cx={x(hp.t)} cy={y(hp.n)} r={4} />
							</>
						) : (
							<circle class="growth__dot" cx={w - 1} cy={y(last.n)} r={3.5} />
						)}
					</svg>
				) : null}
			</div>
			<div class="growth__axis mono">
				<span>{fmt(t0)}</span>
				<span>{t("ahora", "now")}</span>
			</div>
			{undated > 0 ? (
				<p class="growth__note note">
					{t(
						`${int(undated, l)} sin fecha de alta (aún no registradas).`,
						`${int(undated, l)} without a date (not recorded yet).`,
					)}
				</p>
			) : null}
		</figure>
	);
}
