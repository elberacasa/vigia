// The atlas stylesheet travels inside the lazy page chunk as a minified string (scripts/build-web.ts) and is added
// once on import, before the first render, so the wall's first load never pays for it. The shared panel and page
// sheets go in first: the atlas rules must come after them, as they did when those lived in the main stylesheet.
import { addStyles } from "../../lib/css.ts";
import css from "../../styles/atlas.css?inline";
import pagesCss from "../../styles/pages.css?inline";
import panelsCss from "../../styles/panels.css?inline";

addStyles(panelsCss);
addStyles(pagesCss);
addStyles(css);
