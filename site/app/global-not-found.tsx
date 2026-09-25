import type { Metadata } from "next";
import { Mark, Wordmark } from "@/components/Brand";
import { archivo, chivo } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
	title: "Vigía · Página no encontrada / Page not found",
	robots: { index: false, follow: true },
};

/** Any address that is not a page: one bilingual message and the way back to each language. */
export default function GlobalNotFound() {
	return (
		<html lang="es" className={`${archivo.variable} ${chivo.variable}`}>
			<body>
				<main className="graticule grid min-h-dvh place-items-center px-4 py-16">
					<div className="flex max-w-md flex-col items-center text-center">
						<a href="/" className="flex items-center gap-2.5 rounded-md" aria-label="Vigía">
							<Mark size={40} intro={false} />
							<Wordmark height={16} label={false} />
						</a>
						<p className="data mt-10 text-[0.75rem] tracking-[0.14em] text-text-3">404</p>
						<h1 className="mt-3 text-[1.75rem] font-semibold leading-tight tracking-[-0.02em]">
							Esta página no existe.
						</h1>
						<p className="mt-3 text-[0.9375rem] text-text-2">
							Quizás el enlace cambió. La portada tiene todo lo demás.
						</p>
						<p lang="en" className="mt-6 text-[0.9375rem] text-text-3">
							This page does not exist. The link may have changed; the home page has everything else.
						</p>
						<div className="mt-9 flex flex-wrap justify-center gap-3">
							<a href="/" className="btn btn-primary">
								Ir a la portada
							</a>
							<a href="/en" lang="en" hrefLang="en" className="btn btn-ghost">
								English home
							</a>
						</div>
					</div>
				</main>
			</body>
		</html>
	);
}
