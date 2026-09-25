# Vigía landing page

The public page that presents Vigía: a static Next.js site (App Router, React Server Components, Tailwind CSS v4,
Motion, a WebGL hero map drawn with ogl). Spanish at `/`, English at `/en`. It has its own `package.json` and
lockfile; nothing here is part of the app, and the app's `bun run check` does not build it.

Every page is prerendered at build time. There is no server code, no analytics, no cookies, and no request to any
third party: fonts, images, video and the map data are all served from this site.

## Run it

```sh
cd site
bun install
bun run dev        # http://localhost:3000
bun run check      # biome, TypeScript (strict), next build
bun run build && bun run start
```

## Deploy on Vercel

Import the repository in Vercel and set:

| Setting | Value |
|---|---|
| Root Directory | `site` |
| Framework Preset | Next.js (detected) |
| Install Command | `bun install` (detected from `bun.lock`) |
| Build Command | `next build` (default) |
| Output Directory | default (`.next`) |
| Environment | `SITE_URL=https://<your domain>` (without it, Vercel's production domain is used for the canonical URL and the link-preview image; any other host must set it, or `next build` stops rather than ship `localhost` URLs) |

No `vercel.json` is needed. `next.config.ts` sends the security headers on every response: a Content-Security-Policy
that allows only this site's own origin (so the "no third parties" promise is enforced by the browser), `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`, `frame-ancestors 'none'` and, on
Vercel, HSTS. Leave Vercel Analytics and Speed Insights off: the page promises no tracking.

## Where the content comes from

Nothing on the page is typed by hand if the code can say it. Two scripts in the repository root write the inputs:

- `bun scripts/site-data.ts` (root dependencies): `src/data/facts.json` (numbers derived from the code: sources,
  publishers, panels, tests, licences, the app's first-load size from `scripts/build-web.ts`),
  `src/data/contracts.json` (the adapter contract as written in `src/core/types.ts`), `src/data/map.json` (the app's
  own state outlines plus a snapshot of connectivity, earthquakes and fires from a running Vigía), and
  `src/data/captures/` (the terminal report and one API row, as the app printed them). `--no-live` keeps the
  previous snapshot; `--no-web` keeps the previous first-load size.
- `bun scripts/site-capture.ts` (needs a running Vigía on :7722 and, for the map stills, this site on :7761; ffmpeg
  and ImageMagick): the screen recording (`public/media/hero.webm`, `hero.mp4`), its poster and chapters
  (`src/data/media.json`), the desktop and phone stills, the panel crops, the hero map's still images,
  `public/og.png` (rendered from `scripts/og.html`) and the README's `docs/assets/demo.gif`. Last, every file under
  `public/media` gets a content-hashed name and `src/data/media-files.json` maps the plain names to them (the page
  reads it through `src/lib/media.ts`), so the year-long `immutable` cache never hides a new capture. After replacing
  a file by hand, run `bun scripts/site/media.ts`.

The page states when each snapshot was taken; refresh them before a release.
