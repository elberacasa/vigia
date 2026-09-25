import { render } from "preact";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/layout.css";
import "./styles/live.css";
import "./styles/map.css";
import "./styles/honesty.css";
import "./styles/custom-base.css";
import { App } from "./App.tsx";
import { start } from "./lib/data.ts";

/** The built page preloads the app's stylesheet without blocking the first paint (scripts/build-web.ts); apply it. */
function stylesReady(): Promise<void> {
	const preload = document.getElementById("app-css");
	if (!(preload instanceof HTMLLinkElement)) return Promise.resolve();
	const sheet = document.createElement("link");
	sheet.rel = "stylesheet";
	sheet.crossOrigin = "anonymous";
	sheet.href = preload.href;
	const ready = new Promise<void>((resolve) => {
		sheet.addEventListener("load", () => resolve(), { once: true });
		sheet.addEventListener("error", () => resolve(), { once: true });
	});
	preload.after(sheet);
	return ready;
}

const root = document.getElementById("app");
const started = root ? start() : Promise.resolve();
const rendered = stylesReady().then(() => {
	if (!root) return;
	// The static shell in index.html is only a placeholder; start from an empty root so Preact never reuses it.
	root.replaceChildren();
	render(<App />, root);
});

// Offline shell (not on localhost dev reloads of the source server, where assets are rebuilt constantly). The worker
// registers once the app is on screen (not at "load", which the preloads and fonts delay on a slow link); its
// install only fetches the page, as the script and styles are already in the HTTP cache. Once the first data is in,
// it fetches the on-demand chunks in the background (web/static/sw.js).
if ("serviceWorker" in navigator && !location.search.includes("nosw")) {
	void rendered.then(() => {
		navigator.serviceWorker.register("/sw.js").catch(() => {});
		void Promise.all([navigator.serviceWorker.ready, started]).then(([reg]) =>
			reg.active?.postMessage("precache"),
		);
		tellBuild();
	});
}

/** Tells the worker which build this tab runs, now and whenever a new worker takes over (web/static/sw.js). */
function tellBuild(): void {
	const build = document.querySelector('meta[name="vigia-build"]')?.getAttribute("content");
	if (!build) return;
	const say = () => navigator.serviceWorker.controller?.postMessage(`build:${build}`);
	void navigator.serviceWorker.ready.then(say);
	navigator.serviceWorker.addEventListener("controllerchange", say);
}
