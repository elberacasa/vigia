import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";

/**
 * The desktop status bar (ui/StatusBarView.tsx), fetched as its own chunk only when the window is desktop-wide,
 * so phones never download it. --statusbar-h (styles/live.css) reserves its 28 px from the first paint.
 */
const WIDE = "(min-width: 1000px)";

let loading: Promise<FunctionComponent> | null = null;
export function loadDesk(): Promise<typeof import("./StatusBarView.tsx")> {
	return import("./StatusBarView.tsx");
}
function loadView(): Promise<FunctionComponent> {
	loading ??= loadDesk().then((m) => m.default);
	return loading;
}

export function StatusBar() {
	const [View, setView] = useState<FunctionComponent | null>(null);
	useEffect(() => {
		const media = matchMedia(WIDE);
		const check = () => {
			if (media.matches && !View)
				void loadView()
					.then((c) => setView(() => c))
					.catch(() => {});
		};
		check();
		media.addEventListener("change", check);
		return () => media.removeEventListener("change", check);
	}, [View]);
	return View ? <View /> : null;
}
