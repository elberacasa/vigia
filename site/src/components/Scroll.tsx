import type { ReactNode } from "react";

/**
 * A horizontally scrollable region (code, the terminal, the architecture diagram) that a keyboard can reach and
 * scroll in every browser: focusable, named, announced as a region.
 */
export function Scroll({
	label,
	className = "",
	children,
}: {
	label: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
		<section tabIndex={0} aria-label={label} className={`overflow-x-auto ${className}`}>
			{children}
		</section>
	);
}
