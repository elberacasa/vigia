import { addStyles } from "../lib/css.ts";
import panelsCss from "../styles/panels.css?inline";

addStyles(panelsCss);

/**
 * A small line chart drawn in SVG. Values are plotted as given (computed on the server); the chart only scales.
 * Accessible: the caller gives a text summary; the SVG itself is decorative.
 */
export function Sparkline(props: {
	values: readonly number[];
	width?: number;
	height?: number;
	/** Draw a baseline (e.g. the official rate) as a dashed line. */
	reference?: number | undefined;
	tone?: "signal" | "info" | "muted";
	summary: string;
}) {
	const { values, width = 240, height = 48, reference, tone = "signal" } = props;
	if (values.length < 2) return <span class="sr-only">{props.summary}</span>;
	const all = reference !== undefined ? [...values, reference] : [...values];
	const min = Math.min(...all);
	const max = Math.max(...all);
	const span = max - min || 1;
	const pad = 3;
	const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
	const y = (v: number) => pad + (1 - (v - min) / span) * (height - 2 * pad);
	const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
	const area = `${line}L${x(values.length - 1).toFixed(1)} ${height}L${x(0).toFixed(1)} ${height}Z`;
	const last = values[values.length - 1] as number;
	return (
		<figure class={`spark spark--${tone}`}>
			<svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
				<path d={area} class="spark__area" />
				{reference !== undefined ? (
					<line x1={0} x2={width} y1={y(reference)} y2={y(reference)} class="spark__ref" />
				) : null}
				<path d={line} class="spark__line" vector-effect="non-scaling-stroke" />
				<circle cx={x(values.length - 1)} cy={y(last)} r={2.5} class="spark__dot" />
			</svg>
			<figcaption class="sr-only">{props.summary}</figcaption>
		</figure>
	);
}
