import type { Lang } from "@/lib/i18n";
import { FinalCta, Licence } from "./Closing";
import { Developers } from "./Developers";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { Numbers } from "./Numbers";
import { Panels } from "./Panels";
import { Principles } from "./Principles";
import { RunIt } from "./RunIt";
import { Shell } from "./Shell";
import { Sources } from "./Sources";

export function Landing({ lang }: { lang: Lang }) {
	return (
		<Shell lang={lang} page="home">
			<Hero lang={lang} />
			<HowItWorks lang={lang} />
			<Panels lang={lang} />
			<Sources lang={lang} />
			<Principles lang={lang} />
			<Numbers lang={lang} />
			<RunIt lang={lang} />
			<Developers lang={lang} />
			<Licence lang={lang} />
			<FinalCta lang={lang} />
		</Shell>
	);
}
