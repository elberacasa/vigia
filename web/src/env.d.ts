declare module "*.css";
declare module "*.svg" {
	const url: string;
	export default url;
}
/** A stylesheet as a minified string, inserted on demand by lib/css.ts (see scripts/build-web.ts). */
declare module "*.css?inline" {
	const css: string;
	export default css;
}
