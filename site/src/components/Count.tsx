import { type Lang, num } from "@/lib/i18n";

/**
 * A number that counts up once when it scrolls into view (CountObserver). The final value is in the HTML: without
 * JavaScript, with reduced motion, or when it is already on screen at load, it simply shows. Screen readers get the
 * value once, from the hidden copy.
 */
export function Count({ lang, value, className = "" }: { lang: Lang; value: number; className?: string }) {
	const text = num(lang, value);
	return (
		<>
			<span
				aria-hidden="true"
				data-count={value}
				className={`inline-block tabular-nums ${className}`}
				style={{ minWidth: `${text.length}ch` }}
			>
				{text}
			</span>
			<span className="sr-only">{text}</span>
		</>
	);
}
