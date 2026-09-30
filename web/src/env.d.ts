declare module "*.css";
/**
 * The crowd report's proof-of-work worker, built on its own (scripts/build-web.ts defines it as
 * "/pow.worker-<hash>.js"); undeclared in tests, which run the sources directly (read it with `typeof`).
 */
declare const __POW_WORKER__: string;
declare module "*.svg" {
	const url: string;
	export default url;
}
/** A stylesheet as a minified string, inserted on demand by lib/css.ts (see scripts/build-web.ts). */
declare module "*.css?inline" {
	const css: string;
	export default css;
}
/** hls.js's light build (no subtitles, EME or alternate audio), typed as the full one. */
declare module "hls.js/light" {
	import Hls from "hls.js";
	export default Hls;
}
