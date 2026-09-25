// The "Personalizar" sheet's stylesheets travel inside its lazy chunk and are added once on import, before the first
// render, so the wall's first load never pays for them. The preset cards share the first-run sheet's styles.
import { addStyles } from "../../lib/css.ts";
import css from "../../styles/custom.css?inline";
import onboardingCss from "../../styles/onboarding.css?inline";

addStyles(onboardingCss);
addStyles(css);
