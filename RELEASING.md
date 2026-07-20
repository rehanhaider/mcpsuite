# Releasing

Releases are **tag-driven**: pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which publishes container images, builds
per-arch tarballs, and creates a GitHub Release. `package.json` at the repo
root is the single version source — the tag must match it.

## Cutting a release

1. Bump `version` in `package.json`, commit.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. Watch the **Release** workflow. Four jobs:
   - **preflight** — tag ↔ `package.json` version match, secrets audit.
     Fails early and loudly on any mismatch; nothing gets half-published.
   - **image** — one multi-arch build (`linux/amd64` + `linux/arm64`, buildx +
     QEMU) pushed to GHCR always, and to Docker Hub when its secrets exist.
   - **tarball** (×2, `x86_64` / `arm64`) — runs
     `.scripts/release/build-tarball.sh --arch <arch>`, then smoke-tests the
     artifact: executes the bundled `node` natively (each arch builds on a matching
     runner: `ubuntu-latest` / `ubuntu-24.04-arm`), verifies
     the ELF arch of both `node` and `better_sqlite3.node` (a **native**
     module), and opens a real in-memory database through it. A wrong-arch or
     broken artifact fails the job — it is never attached to a release.
   - **publish** — GitHub Release for the tag with both tarballs +
     `SHA256SUMS` (`sha256sum -c SHA256SUMS` verifies downloads).

A version with a `-` (e.g. `v0.5.0-rc.1`) is marked prerelease and does not
move the `latest` image tags.

## Image names and tags

| Registry | Image | When |
| --- | --- | --- |
| Docker Hub (canonical) | `docker.io/mcpsuite/crm` | only when Docker Hub secrets are configured |
| GHCR (mirror) | `ghcr.io/rehanhaider/mcpsuite-crm` | always (uses `GITHUB_TOKEN`) |

Tags per release: `X.Y.Z` and `latest` (stable releases only). The GHCR name
is `<owner>/mcpsuite-crm` (computed from the repository owner, lowercased) —
it mirrors the Docker Hub `mcpsuite/crm` shape and attaches to this repo via
the `org.opencontainers.image.source` label baked into the Dockerfile.

## Secrets and variables

| Name | Kind | Required? | Purpose |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | automatic | always present | GHCR push (`packages: write`), release creation (`contents: write`) |
| `DOCKERHUB_USERNAME` | secret | optional pair | Docker Hub login (the publishing account) |
| `DOCKERHUB_TOKEN` | secret | optional pair | Docker Hub access token (read/write scope) |
| `DOCKERHUB_IMAGE` | repo **variable** | optional | overrides the Docker Hub image name (default `mcpsuite/crm`) if the namespace lands elsewhere |

Secrets behavior (checked in preflight):

- **both** Docker Hub secrets set → images also push to Docker Hub.
- **neither** set → Docker Hub is skipped with a workflow warning
  (mirror-first dormancy; GHCR still publishes).
- **exactly one** set → preflight fails with a clear error. Fix or remove.

## Claiming Docker Hub (flipping mirror-skip → canonical)

1. Register the `mcpsuite` namespace on Docker Hub (org or user) and create
   the `crm` repository. If the name ends up different, set the repo variable
   `DOCKERHUB_IMAGE` (e.g. `someotherns/crm`).
2. Create an access token: Docker Hub → Account Settings → Personal access
   tokens → **Read & Write** scope.
3. In this GitHub repo: Settings → Secrets and variables → Actions → add
   `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
4. Re-run the newest tag's Release workflow (or cut the next release). No
   workflow edits needed — preflight detects the secrets and the same build
   pushes to both registries.

**First GHCR publish is private.** GitHub creates the `mcpsuite-crm` package
private by default. After the first release: package page → Package settings →
Change visibility → Public. One-time.

## Failure modes and re-runs

- **Re-runs are idempotent**: image tags are overwritten in place; if the
  GitHub Release already exists, assets are re-uploaded with `--clobber`.
- **Images push before the Release is created.** If a tarball job fails, the
  images for that version are already live but no GitHub Release exists —
  fix, then re-run the workflow for the same tag.
- **`latest` follows the most recently pushed tag**, not the highest version.
  After tagging a backport (e.g. `v0.1.1` after `v0.2.0`), re-run the newest
  version's workflow to restore `latest`.
- **arm64 image builds run under QEMU** and are slow (the job allows 120
  minutes). If this becomes painful, split the image job onto a native
  `ubuntu-24.04-arm` runner (free for public repos).

## Contract with `.scripts/release/build-tarball.sh`

The workflow assumes: invoked as `build-tarball.sh --arch x86_64` or
`--arch arm64` from an installed workspace; produces exactly **one** `.tar.gz`
per invocation, either in `dist-release/` (preferred) or anywhere outside
`node_modules/` (discovered by mtime, `node-*.tar.gz` runtime downloads
excluded); the tarball is self-contained — bundled `node` binary plus
`better-sqlite3` (including its `better_sqlite3.node` binding) for the target
arch. If any of that changes, update the `Locate tarball` and smoke steps in
`release.yml`.

CI note (`ci.yml`): PRs and pushes to `main` run install → build → test →
typecheck with plain `actions/setup-node` + corepack pnpm 10 (no mise). Build
precedes typecheck because `apps/web/src/routeTree.gen.ts` is generated and
gitignored. No secrets are used, so fork PRs are safe.
