import localFont from "next/font/local";

/** The app's own type pairing, self-hosted (SIL Open Font License, src/fonts/OFL.txt). */
export const archivo = localFont({
	src: "../fonts/archivo-2.woff2",
	weight: "100 900",
	variable: "--font-archivo",
	display: "swap",
	adjustFontFallback: "Arial",
});

export const chivo = localFont({
	src: "../fonts/chivo-mono-1.woff2",
	weight: "400 700",
	variable: "--font-chivo",
	display: "swap",
	adjustFontFallback: false,
	// Only small captions and code use it: it swaps in later instead of competing with the first paint.
	preload: false,
	fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
