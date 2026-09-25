import { signal } from "@preact/signals";
import { route } from "./router.ts";

/** The domain asked on /bloqueos?dominio=…, kept in sync with back/forward. */
function queryDomain(): string {
	return new URLSearchParams(location.search).get("dominio") ?? "";
}

export const lookupDomain = signal(queryDomain());
addEventListener("popstate", () => {
	lookupDomain.value = queryDomain();
});

/** Opens the "¿Está bloqueado?" page for a domain without reloading. */
export function openLookup(domain: string): void {
	history.pushState(null, "", `/bloqueos${domain ? `?dominio=${encodeURIComponent(domain)}` : ""}`);
	lookupDomain.value = domain;
	route.value = "bloqueos";
	window.scrollTo({ top: 0 });
}
