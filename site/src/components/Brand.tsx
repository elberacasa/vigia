import { WORDMARK_ACCENT, WORDMARK_LETTERS, WORDMARK_VIEWBOX } from "@/lib/wordmark-paths";

/**
 * The Vigía mark (the same geometry as the app's web/src/ui/Logo.tsx): a V, the lookout's field of view, facing an
 * arc of eight points, the stars of the flag and the blips on a watch screen.
 */
const CX = 32;
const CY = 53;
export const ARC = Array.from({ length: 8 }, (_, i) => (-33 + (i * 66) / 7) * (Math.PI / 180));
const DOTS = ARC.map((a) => ({ x: CX + 43 * Math.sin(a), y: CY - 43 * Math.cos(a) }));
const beam = (deg: number) => {
	const a = (deg * Math.PI) / 180;
	return `${(CX + 33 * Math.sin(a)).toFixed(2)} ${(CY - 33 * Math.cos(a)).toFixed(2)}`;
};
const V_PATH = `M${beam(-30)} L${CX} ${CY} L${beam(30)}`;

export function Mark({ size = 28, intro = true }: { size?: number; intro?: boolean }) {
	return (
		<svg
			className={`mark${intro ? " mark--intro" : ""}`}
			viewBox="0 0 64 64"
			width={size}
			height={size}
			aria-hidden="true"
			focusable="false"
		>
			<path className="mark__v" d={V_PATH} pathLength={1} />
			<g className="mark__dots">
				{DOTS.map((d, i) => (
					<circle
						key={d.x}
						cx={d.x.toFixed(2)}
						cy={d.y.toFixed(2)}
						r="2.5"
						style={{ "--i": i } as React.CSSProperties}
					/>
				))}
			</g>
		</svg>
	);
}

export function Wordmark({ height = 15, label = true }: { height?: number; label?: boolean }) {
	return (
		<svg
			className="wordmark"
			viewBox={WORDMARK_VIEWBOX}
			height={height}
			width={(height * 3807) / 900}
			{...(label ? { role: "img", "aria-labelledby": "wordmark-title" } : { "aria-hidden": true })}
		>
			<title id={label ? "wordmark-title" : undefined}>Vigía</title>
			<g className="wordmark__letters">
				{WORDMARK_LETTERS.map((d) => (
					<path key={d.slice(0, 16)} d={d} />
				))}
			</g>
			<path className="wordmark__accent" d={WORDMARK_ACCENT} />
		</svg>
	);
}
