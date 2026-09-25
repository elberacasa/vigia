import type { CSSProperties, ReactNode } from "react";

/**
 * Content that settles into place once as it scrolls into view. Plain CSS plus one observer (RevealObserver), which
 * also arms the hidden starting state: without JavaScript, if it fails to load, or with reduced motion, everything
 * is simply there.
 */
export function Reveal({
	children,
	delay = 0,
	className = "",
	as = "div",
}: {
	children: ReactNode;
	delay?: number;
	className?: string;
	as?: "div" | "li";
}) {
	const Tag = as;
	const style = delay ? ({ "--reveal-delay": `${delay}s` } as CSSProperties) : undefined;
	return (
		<Tag className={`reveal ${className}`} style={style}>
			{children}
		</Tag>
	);
}
