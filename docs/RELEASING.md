# Releasing Dockify

A release is a git tag. Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which builds the
images, writes and signs the release feed, publishes the GitHub Release and updates the `releases`
branch that installs read from. Nobody builds, signs or uploads anything from a laptop.

What an install trusts:

- One minisign (Ed25519) public key. It is committed at `deploy/release.pub`, baked into the
  control image, and pinned in `installer/install.sh` as `DOCKIFY_DEFAULT_PUBKEY`.
- One feed per channel: `releases/stable.json` and `releases/beta.json`, each with a `.minisig`
  beside it. The control plane verifies the signature over the exact bytes before it parses them,
  and the signed trusted comment must name the channel and the newest version.
- Images by digest only, per architecture. A tag in the feed is refused.

The feed format is the `ReleaseFeed` schema in
`apps/api/src/modules/platform/updates/release.ts`. `scripts/release/make-manifest.mjs` writes it
and checks every rule that schema has, so a bad feed fails the release, not the installs.

## Files

| Path | What it is |
| --- | --- |
| `docs/releases/<version>.md` | The release notes. The site changelog renders the same files. |
| `docs/releases/security/<version>.json` | Only for a security release: its security block (see "Marking a security release"). |
| `scripts/release/make-manifest.mjs` | Writes one channel file for a new release. |
| `scripts/release/sign.sh` | Signs a channel file with minisign, then verifies it. |
| `scripts/release/verify.sh` | Verifies a published channel file and lists its versions. |
| `deploy/release.pub` | The public key. |
| `installer/install.sh` | `DOCKIFY_DEFAULT_PUBKEY` and `DOCKIFY_DEFAULT_FEED`. |

The `releases` branch holds, at its root:

```
minisign.pub
releases/stable.json
releases/stable.json.minisig
releases/beta.json
releases/beta.json.minisig
releases/<version>/docker-compose.yml
releases/<version>/socket-proxy/haproxy.cfg
releases/notes/<version>.md
```

The feed base defaults to `https://raw.githubusercontent.com/kedarpixels/Dockify/releases`, and an
install reads `<feed>/releases/<channel>.json`.

## The key ceremony (once, and again on rotation)

Do this on an offline machine: a laptop with networking off, or a live USB that never goes online.
The secret key never touches a machine that holds a checkout of this repository.

1. Install minisign 0.11 or newer.
2. Generate the key pair with a strong password (a passphrase of at least six random words):

   ```sh
   minisign -G -p dockify-release.pub -s dockify-release.key
   ```

   Never use `-W` (no password). The password is the second factor if the key file leaks.
3. Back up the secret key: two encrypted USB drives (or one drive and a printed copy of the key
   file in a sealed envelope), kept in two separate places. Store the password in the maintainers'
   password manager, never next to the key backups.
4. Copy only `dockify-release.pub` off the offline machine.
5. In a reviewed commit, put the public key in:
   - `deploy/release.pub` (the whole `.pub` file: the `untrusted comment:` line and the key line).
   - `installer/install.sh`: `DOCKIFY_DEFAULT_PUBKEY="<the key line, the base64 line only>"`.
   - `installer/install.sh`: `DOCKIFY_DEFAULT_FEED="https://raw.githubusercontent.com/kedarpixels/Dockify/releases"`
     (or the dockify.sh mirror, see below). Check what the installer expects there before you set it.

   The release workflow fails when the two keys differ or either is empty.
6. In the repository settings, create an environment named `release`:
   - Required reviewers: at least one maintainer other than the person who tags.
   - Deployment branches and tags: only tags matching `v*.*.*`.
   - Secrets: `MINISIGN_SECRET_KEY` (the full contents of `dockify-release.key`) and
     `MINISIGN_PASSWORD`.

   Paste the secret from the offline machine through a one-off channel (for example a USB drive
   to the machine with the browser), then wipe that copy. Do not put the key in repository or
   organisation level secrets: only the `release` environment, behind its reviewers.
7. Protect tags: a tag ruleset on `v*` that blocks deletion and updates, so a published tag can
   never move.

## Cutting a release

1. Make sure `main` is green in CI and has everything the release needs.
2. Write the notes (next section) in `docs/releases/<version>.md` and set the heading to the
   release date, for example `## 1.1.0 (2026-11-03)`. For a security release add
   `docs/releases/security/<version>.json` too (see "Marking a security release"). Commit them to `main`
   through a pull request.
3. Check `deploy/release.pub` and `DOCKIFY_DEFAULT_PUBKEY` are the current key.
4. List every migration the release ships for the first time in
   `packages/db/prisma/released-migrations.json`, with the sha256 of its `migration.sql`
   (`sha256sum packages/db/prisma/migrations/<name>/migration.sql`), in the same pull request.
   From then on `released-migrations.test.ts` fails if that file changes: installs keep the
   checksum of what they applied and never run a migration twice, so a fix goes in a new one.
5. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -s v1.1.0 -m "Dockify 1.1.0"
   git push origin v1.1.0
   ```

6. The workflow runs `prepare` (tag format, the tag is on the default branch, notes exist and are
   dated, the key pins match), then `images` (both targets for linux/amd64 and linux/arm64, with
   provenance and an SBOM, pushed to `ghcr.io/kedarpixels/dockify-control` and `dockify-web`).
7. `publish` waits for a reviewer to approve the `release` environment. The reviewer checks the
   tag, the notes and the image job's digests, then approves.
8. `publish` verifies the currently published feed with the trusted key, writes `stable.json` (not
   for a prerelease) and `beta.json` with make-manifest, signs each with sign.sh, verifies each,
   creates the GitHub Release with the notes as its body and the channel files, signatures,
   `docker-compose.yml`, `haproxy.cfg` and `minisign.pub` attached, then commits the files to the
   `releases` branch and pushes.
9. Verify by hand (below) and mirror to dockify.sh if you use the mirror.

The GHCR packages must be public, or installs cannot pull them: after the first release, set
`dockify-control` and `dockify-web` to public in the package settings.

## Writing the notes

`docs/releases/<version>.md`, exactly this shape (empty groups left out):

```md
## 1.1.0 (2026-11-03)

One line that says what this release is for.

### Added
- New things you can do.

### Changed
- Things that work differently. Say what to do if it affects you.

### Fixed
- Bugs, named by what you saw, not by the code.

### Security
- Fixes with a CVE or advisory link, and who reported it if they agree.
```

While a version is still being worked on its heading is `## 1.1.0 (unreleased)`. make-manifest
refuses notes that say unreleased, or whose version or date disagree with the release, and notes
over 20000 characters. The notes go into the feed as they are, and installs show them escaped.

## Marking a security release

A release that fixes a serious security bug carries a security block. Every install that runs an
older version then shows its admins a red "Important security release" popup on any console page,
shows every member a red banner under the top bar until the fix is installed, puts a notice in the
bell, and emails every admin once (the security variant of the update notice).

1. In the same pull request as the notes, add `docs/releases/security/<version>.json`:

   ```json
   {
     "level": "critical",
     "summary": "A crafted log viewer request could read files outside the log folder. Every install from 1.2.0 to 1.4.0 is affected.",
     "advisory": "https://github.com/kedarpixels/Dockify/security/advisories/GHSA-xxxx-xxxx-xxxx",
     "cves": ["CVE-2026-12345"]
   }
   ```

   - `level`: `critical` (an admin can put the popup off for at most 3 days) or `important`
     (at most 7 days).
   - `summary`: one line of plain text, at most 600 characters, no markup: what the fix closes and
     who is exposed. It is shown escaped in the popup, the banner's bell notice and the email.
   - `advisory`: optional, https only. The popup and the email link to it as "Read the advisory".
     Publish the advisory before the tag, or the link is dead when installs see it.
   - `cves`: optional, CVE ids, each once, at most 20.

   Write the same fix under `### Security` in the notes.
2. Tag and release as usual. make-manifest reads the file beside the notes, checks it (an unknown
   key, a level it does not know, a line break in the summary or a plain http link fails the
   release), writes it into the release's entry as `security`, and sets `critical: true`, so
   installs set to "security only" take the release in their next window too.
3. The block is part of the signed bytes like every other field, so nobody can raise an alert or
   take one away without the release key. An install ignores a block it cannot read (a level a
   future version adds, say) but keeps the release, so the update that fixes the issue is still
   offered.

What an install shows: the security block of the newest release above its own version that has
one, at the highest level of every such release, with all their CVE ids. A newer release without a
block never hides an older pending fix, and a newer security release opens the popup again even for
an admin who put the older one off.

To mark an already published release, write the file and change the entry (see "Changing an
entry"); make-manifest picks the file up for that version, or pass `--security FILE`.

## critical and minFrom

- `critical: true` marks a security release. Installs set to "security only" take it in their next
  window. A security block sets it (see above). Without a block, set it with `--critical` on
  make-manifest, or with a `Critical: true` trailer in the annotated tag message, which the
  workflow reads. Prefer the security block for a real security fix: `critical` alone installs
  under "security only" but raises no popup, banner or email.
- `minFrom` is the oldest version that may upgrade straight to this release. An older install is
  offered the newest release it may take, and steps forward one hop at a time. By default each
  release keeps the previous newest entry's `minFrom` (0.0.0 for the first). Raise it with
  `--min-from X.Y.Z` when a release needs a migration or a data change that only works from a
  certain version, and say so in the notes under Changed.
- `migration` is computed: the newest folder under `packages/db/prisma/migrations`.

### Changing an entry

A published version is never rebuilt. To change the metadata of an entry (critical, minFrom, the
security block), run make-manifest with `--replace` and the same digests from the published feed,
then sign, verify and commit to the `releases` branch, through a reviewed change. `--replace`
without a reason is a mistake. A security block can be added or raised from important to critical
this way; raising the level opens the popup again for admins who put it off. Taking a block away
removes the alert from every install, so do that only for a block published by mistake.

## Beta releases

Tag `vX.Y.Z-beta.N` or `vX.Y.Z-rc.N`. The notes file is `docs/releases/X.Y.Z-beta.N.md` with the
heading `## X.Y.Z-beta.N (YYYY-MM-DD)`. A prerelease goes into `beta.json` only and the GitHub
Release is marked prerelease. A stable tag goes into both `stable.json` and `beta.json`, so the
beta channel always has the newest of both. In the feed a prerelease sorts before its release.

## Verifying a release by hand

With minisign installed (and jq or Node):

```sh
sh scripts/release/verify.sh https://raw.githubusercontent.com/kedarpixels/Dockify/releases/releases/stable.json
sh scripts/release/verify.sh ./stable.json "$(tail -n 1 deploy/release.pub)"
```

It checks the signature against the key, the schema, and that the trusted comment names the
channel and the newest version, then prints every version. Then check the images:

```sh
docker buildx imagetools inspect ghcr.io/kedarpixels/dockify-control@sha256:<digest from the feed>
```

and that `composeSha256` and `socketProxySha256` match `sha256sum` of the files under
`releases/<version>/` on the `releases` branch.

## Mirroring to dockify.sh

The mirror serves the same files byte for byte, at the same paths under
`https://dockify.sh/releases/...`. Copy from the `releases` branch; never edit, reformat or
re-sign a file on the way. After copying, run verify.sh against the mirror URL. Because the files
are signed, a mirror needs no trust of its own; a mirror that falls behind is only stale, and an
install refuses a feed older than one it has already seen.

## Rotating the key

A rotation takes two releases, so every install that keeps updating learns the new key from a
release it already trusts.

1. Run the key ceremony for a new key pair. Keep the old secret key.
2. Release N, signed by the OLD key, ships the NEW public key:
   - Commit the new key to `deploy/release.pub` and `DOCKIFY_DEFAULT_PUBKEY`.
   - Set the repository variable `MINISIGN_SIGNING_PUBLIC_KEY` to the OLD key line, so sign.sh
     verifies against the key that actually signs this release. The secrets stay the old key.
   - Tag and release. Installs verify N with the old key, and the image they move to pins the new
     key.
3. Release N+1, signed by the NEW key:
   - Replace `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` in the `release` environment with the
     new ones.
   - Delete `MINISIGN_SIGNING_PUBLIC_KEY`, and set `MINISIGN_PREVIOUS_PUBLIC_KEY` to the OLD key
     line, so the workflow still accepts the published feed (signed by the old key) as the
     previous one.
   - Tag and release. After it is out, delete `MINISIGN_PREVIOUS_PUBLIC_KEY`.
4. Destroy the old secret key and its backups once N+1 is out.

An install that skipped release N cannot verify N+1. Say in the notes of N+1 that such installs
must update to N first, or reinstall with `--release-pubkey`.

## If the secret key leaks

1. Remove `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` from the `release` environment at once,
   so nothing more is signed with it.
2. Check what was signed: the history of the `releases` branch, the GitHub Releases, and any feed
   files on the mirror. Remove anything not produced by the workflow from a reviewed tag.
3. If the old key may still be in the attacker's hands while installs trust it, a rotation through
   a release signed by that key is not safe: anyone holding it can sign a feed too. Publish a
   security advisory, run the key ceremony for a new key, release with the new key pinned in
   `deploy/release.pub` and the installer, and tell every operator to reinstall or set the new
   key by hand (`--release-pubkey`, or `DOCKIFY_RELEASE_PUBKEY` in `.env` together with an image
   that pins it).
4. Write down what happened and when in the advisory.

If only the password leaked, rotate anyway; the key file is the part an attacker still needs.

## Never

- Sign from a machine that has a checkout of this repository, or keep the secret key inside one.
  sign.sh refuses a key inside a git work tree.
- Commit a secret key, a password, or a `.minisig` made by hand.
- Push a tag without dated notes. The workflow fails, and the tag is then burnt: fix the notes
  and use the next version.
- Move, delete or re-push a tag. A version names one set of digests forever.
- Rebuild an image for a published version, or point the feed at a tag instead of a digest.
- Edit a migration a release shipped (`packages/db/prisma/released-migrations.json`). Write a new one.
- Edit a published channel file by hand. Every change goes through make-manifest and sign.sh.
- Sign with `-W` keys or store the key in repository or organisation secrets.
