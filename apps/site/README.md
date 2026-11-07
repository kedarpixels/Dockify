# Dockify site

The public marketing site and docs for Dockify. Next.js App Router, Geist, Geist Mono and Geist Pixel,
no client data fetching beyond the docs search index. Docs pages live in `content/docs/*.mdx`; the
sidebar order is `lib/docs-nav.ts`.

## Run and check

Needs Node 22.18 or newer, and the whole repository checked out: the build reads `../../installer`,
`../../docs/releases` and the dashboard's shared primitives in `../web`.

```sh
cd apps/site
npm ci
npm run typecheck    # tsc --noEmit
npm run lint         # eslint, the same rules as apps/web
npm run build        # runs the prebuild first, then next build
npm run start:standalone   # http://localhost:3007
```

`npm run build` runs `prebuild` first:

- `scripts/publish-installer.mjs` copies the installer and uninstaller (with their SHA-256 files) into
  `public/` and the release notes into `content/releases/`.
- `scripts/sync-ui.mjs --check` fails the build when a shared primitive (theme switch, copy key, tip
  guard, rules and nodes, shortcuts, burger, click sound) or the shared base styles
  (`app/styles/foundation-shared.css`) differ from the copy in `apps/web`. Run
  `npm run sync-ui` to copy the dashboard's versions over, then check the site.

Other scripts: `npm run icons` regenerates `components/icon-glyphs.ts` (only the geist-icons the site
uses ship to the browser), and `node scripts/resize-shots.mjs` writes the 1440px product shots after a
screenshot is replaced.

### Build settings

Set these at build time. All are optional.

| Variable | What it does | Default |
|---|---|---|
| `SITE_URL` | Public origin, with no trailing slash. Used for canonical URLs, the sitemap, robots.txt, JSON-LD and the host on the social cards. | `https://dockify.sh` |
| `SITE_NOINDEX` | `1` or `true` makes robots.txt disallow everything and adds `noindex` to every page. | unset |

To keep a staging deploy out of search engines, build it with `SITE_NOINDEX=1`.

### The repository

`REPO_URL` in `lib/site.ts` is the public GitHub repository, and every link and mention reads from
it. If it is null, the GitHub links, "Edit on GitHub", issue links, private vulnerability reporting
and the signed release links are hidden or written without a link.

`DISCUSSIONS_ON` in the same file adds the footer's Discussions link once GitHub Discussions is on.

## Deploy

`output: "standalone"` traces from the repository root, so the server is
`.next/standalone/apps/site/server.js`, and it serves static files only from
`.next/standalone/apps/site/.next/static` and `.next/standalone/apps/site/public`. The build does
not copy those; `npm run start:standalone` (`scripts/start-standalone.mjs`) does, then starts the
server with `PORT` (default 3007) and `HOSTNAME` (default `0.0.0.0`).

Any host that runs Node 22.18 or newer works:

```sh
npm ci && npm run build
PORT=3007 HOSTNAME=0.0.0.0 npm run start:standalone
```

On Dockify, an app builds from a Dockerfile, and the site has none yet. Until it does, run it on a
Node host as above. Health check path: `/robots.txt`; it is static and always answers 200.

Every page is prerendered at build time. `proxy.ts` sets the security headers on each response, with a
Content-Security-Policy that allows each page's inline scripts by their SHA-256, read from the
prerendered HTML once at start: no nonce, no `'unsafe-inline'` for scripts. With an `https://` `SITE_URL`
it also sends `Strict-Transport-Security` for this host (`lib/hsts.ts`), so serve it over https only.

## SEO and assets

- **Titles:** the root layout sets the default title and the template `%s | Dockify`. A page sets
  only its own short title. `pageMetadata()` in `components/seo/metadata.ts` also adds a canonical
  URL and matching Open Graph and Twitter text; use it in a page's `metadata` export.
- **Social cards:** every route has an `opengraph-image.tsx` that calls `renderOg()` in
  `components/seo/og.tsx`. It draws the ruled frame with nodes, two dither bands, the title in Geist
  Pixel and the blue accent, and returns two images per route, dark first, then light. The fonts and
  the logo it needs are in `components/seo/assets` (`logo.png` is the dashboard's 131 by 96
  `dockify-logo.png`).
- **robots.txt and sitemap.xml:** `app/robots.ts` and `app/sitemap.ts`. The sitemap lists every
  marketing route and every docs page in sidebar order.
- **Structured data:** `components/seo/json-ld.tsx` renders a `SoftwareApplication` block in the
  root layout. It carries no rating, review or download counts.
- **Icons:** the dashboard's own brand files (`docs/BRAND.md`): `app/favicon.ico` (16, 32
  and 48 px, the simplified 16 px whale), `app/icon.png` (512 px) and `app/apple-icon.png` (180 px on
  white), plus `public/icon-192.png`, `public/icon-512.png` and `public/icon-maskable-512.png` (the
  mark on a white canvas, inside the maskable safe zone) for `app/manifest.ts`. The header and footer
  draw `public/dockify-logo.png` at 33 by 24, as the dashboard does. When the brand changes, copy the
  dashboard's files again.

## Design rules for this site

The site follows the dashboard's design language (`apps/web/app/styles/foundation-shared.css`). Two choices
are written down here so a later pass does not flip them back:

- **Blue** is for primary keys, focus rings, the live state in the drawings (live, done, traffic) and
  the two dither clouds behind the final call. Eyebrows, step numbers, bullets, icon tiles, the
  selected docs page, search results, notes and links are ink. Links in running text are ink with a
  hairline underline (`.link-inline`).
- **Insets** are `--gutter` (32px from 761px up, 16px on phones) from rails and from inner dividers
  alike, as in the dashboard brief.
- **Code** (blocks, inline code, commands and paths) is Geist Mono, so aligned columns stay aligned.
  The line drawings keep Geist.
- **Whole pixels:** columns are `round(down)` tracks with the last one taking the rest, the frame's
  left offset is rounded down, and drawings sit on whole-pixel boxes and offsets. Where something is
  centred against content of unknown height (the hero's columns, the 404), every height on both
  sides is even, so the centring offset stays whole. The header's rule is an inset shadow, as in the
  dashboard, so its cells keep all 56px.
