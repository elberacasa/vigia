import type { Lang } from "@/lib/i18n";
import { FinalCta, Footer, Licence } from "./Closing";
import { Developers } from "./Developers";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { Numbers } from "./Numbers";
import { Panels } from "./Panels";
import { Principles } from "./Principles";
import { RevealObserver } from "./RevealObserver";
import { RunIt } from "./RunIt";

export function Landing({ lang }: { lang: Lang }) {
	return (
		<>
			<Header lang={lang} />
			<main id="contenido">
				<Hero lang={lang} />
				<HowItWorks lang={lang} />
				<Panels lang={lang} />
				<Principles lang={lang} />
				<Numbers lang={lang} />
				<RunIt lang={lang} />
				<Developers lang={lang} />
				<Licence lang={lang} />
				<FinalCta lang={lang} />
			</main>
			<Footer lang={lang} />
			<RevealObserver />
		</>
	);
}
