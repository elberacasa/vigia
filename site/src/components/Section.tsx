import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

/** A page section: an index and eyebrow, a headline, an optional lede, then its content. */
export function Section({
	id,
	index,
	eyebrow,
	title,
	lede,
	children,
	className = "",
}: {
	id: string;
	index: string;
	eyebrow: string;
	title: ReactNode;
	lede?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} className={`relative py-24 sm:py-32 ${className}`}>
			<div className="wrap">
				<Reveal className="max-w-3xl">
					<p className="eyebrow flex items-center gap-3">
						<span className="text-text-2">{index}</span>
						<span className="h-px w-8 bg-line-strong" aria-hidden="true" />
						{eyebrow}
					</p>
					<h2 id={`${id}-title`} className="h-section mt-5">
						{title}
					</h2>
					{lede ? <p className="lede mt-5 max-w-2xl">{lede}</p> : null}
				</Reveal>
				{children}
			</div>
		</section>
	);
}
