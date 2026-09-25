import files from "../data/media-files.json";

/**
 * The URL of a captured file under public/media, by its plain name ("crops/dinero.webp"). The files carry a content
 * hash in their names (scripts/site/media.ts), so they can be cached for a year and a new capture is still seen.
 */
export function media(name: string): string {
	const url = (files as Record<string, string>)[name];
	if (!url)
		throw new Error(
			`media: no captured file "${name}" (run scripts/site-capture.ts or scripts/site/media.ts)`,
		);
	return url;
}
