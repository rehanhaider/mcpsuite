# Installing MCP Suite CRM on a Linux server

Machine-wide install with systemd, no Docker and **no preinstalled Node.js,
compiler, npm, or source checkout required** — every release tarball bundles
its own Node 22 runtime. For other deployment paths (Docker, reverse proxies,
hardening), see [PRODUCTION.md](PRODUCTION.md).

## What you get

| Path | Purpose |
| --- | --- |
| `/opt/emcp/releases/<version>` | versioned, self-contained app (bundled Node 22) |
| `/opt/emcp/current` | symlink to the active release |
| `/etc/emcp/emcp.env` | configuration (preserved across updates/reinstalls) |
| `/var/lib/emcp/emcp.db` | your SQLite database (owned by the `emcp` user) |
| `/var/lib/emcp/backups/` | timestamped DB+config backups made before updates |
| `/usr/local/bin/emcp` | admin CLI (`emcp --help`) |
| `/etc/systemd/system/emcp.service` | system service — starts on boot, no login needed |

One process serves the web UI, `POST /mcp` (agents), and `GET /healthz` on
`WEB_PORT` (default 2222). It runs as the dedicated unprivileged `emcp`
system user with a hardened unit (`ProtectSystem=strict`, writable only in
`/var/lib/emcp`).

## Requirements

- Linux on **x86_64 or arm64** (64-bit only), glibc ≥ 2.28, kernel ≥ 4.18,
  systemd. musl-based distros (Alpine) and 32-bit systems are not supported.
- **Raspberry Pi:** works on Pi 3/4/5 with a **64-bit OS** (Raspberry Pi OS
  64-bit or Ubuntu Server arm64). 32-bit Raspberry Pi OS will be refused.
- root (`sudo`) for installing; the service itself never runs as root.

## One-line install

```sh
curl -fsSL https://raw.githubusercontent.com/rehanhaider/mcpsuite/main/.scripts/installer/launcher.sh | sudo bash
```

The launcher downloads the real installer to a temp file and runs it **with
your terminal attached** (so piping never breaks prompts). Pass options after
`-s --`:

```sh
curl -fsSL .../launcher.sh | sudo bash -s -- --version 0.2.0 --port 8080
```

At the end the installer prints the **first-run owner setup**: a URL plus a
one-time setup code. It is shown exactly once and stored nowhere — no
passwords ever pass through the installer, its arguments, or logs. Open the
URL, enter the code, choose your password. Lost the code? `sudo emcp
setup-code` prints a fresh one (invalidating the old one).

## Manual install (air-gapped / pinned)

1. From the [releases page](https://github.com/rehanhaider/mcpsuite/releases)
   download `mcpsuite-crm-<version>-linux-<arch>.tar.gz` **and** its
   `.tar.gz.sha256` into the same directory (arch: `x86_64` or `arm64`).
2. Run the installer from the tarball (it verifies the checksum, installs,
   sets up the database, enables + starts the service):

```sh
tar -xzf mcpsuite-crm-<version>-linux-<arch>.tar.gz ./installer/install.sh -O > install.sh
sudo bash install.sh --tarball ./mcpsuite-crm-<version>-linux-<arch>.tar.gz
```

Options for a fresh install: `--port N` (default 2222) and `--base-url URL`
(the public URL used in printed links; set it when behind a reverse proxy).
Both only apply when `/etc/emcp/emcp.env` doesn't exist yet.

## Configuration — `/etc/emcp/emcp.env`

```sh
WEB_PORT=2222                          # port for web UI + /mcp + /healthz
EMCP_BASE_URL=http://localhost:2222    # public base URL used in printed links
DB_PATH=/var/lib/emcp/emcp.db          # SQLite database file
```

After editing: `sudo systemctl restart emcp` (or `sudo emcp restart`).
The file is never overwritten by installs or updates.

## Day-2: the `emcp` CLI

| Command | What it does |
| --- | --- |
| `emcp status` | service state, installed version, `/healthz` probe |
| `emcp logs [-f]` | service logs (journalctl passthrough) |
| `emcp version` | active release + all installed releases |
| `sudo emcp start` / `stop` / `restart` | control the service |
| `sudo emcp setup-code` | fresh one-time owner setup/reset code (printed once) |
| `sudo emcp update [--version X]` | guarded update (see below) |
| `sudo emcp uninstall [--purge]` | remove the app (data kept unless `--purge`) |

## Updates (manual, guarded — never silent)

```sh
sudo emcp update                 # latest GitHub release
sudo emcp update --version 0.2.0 # pin a specific version
sudo emcp update --tarball ./mcpsuite-crm-0.2.0-linux-x86_64.tar.gz  # offline
```

Every update, in order:

1. downloads the pinned release from GitHub Releases and **verifies its
   sha256** against the release's checksum file (aborts on mismatch),
2. shows the plan (`old -> new`) and asks for confirmation (`--yes` for
   non-interactive use),
3. stops the service,
4. **backs up** `emcp.db` (+ WAL/SHM) and `emcp.env` to
   `/var/lib/emcp/backups/<timestamp>/` (retention: last 5, override with
   `EMCP_BACKUP_KEEP`),
5. installs to `/opt/emcp/releases/<version>` and runs database setup
   (a no-op on an existing database until the first post-release schema
   change ships its upgrade steps),
6. swaps the `current` symlink, starts the service, and health-checks
   `GET /healthz`.

**Rollback:** if database setup, start, or the health check fails, the update
automatically restores the `current` symlink to the previous release,
restores the database from the just-made backup, and restarts the old
version. The backup directory is kept either way. Manual disaster recovery:

```sh
sudo emcp stop
sudo cp /var/lib/emcp/backups/<timestamp>/emcp.db* /var/lib/emcp/
sudo ln -sfn releases/<old-version> /opt/emcp/current
sudo emcp start
```

## Uninstall

```sh
sudo emcp uninstall           # removes service + /opt/emcp + CLI;
                              # KEEPS /var/lib/emcp (data) and /etc/emcp (config)
sudo emcp uninstall --purge   # also erases data + config — demands you type
                              # 'delete-my-data' before deleting anything
```

## Building a release tarball (maintainers)

```sh
make release-tarball            # host arch -> dist-release/mcpsuite-crm-<v>-linux-<arch>.tar.gz (+ .sha256)
make release-check              # bash -n / shellcheck over installer + release scripts
```

`build-tarball.sh` builds the web app, installs production `node_modules`,
downloads and SHASUMS256-verifies the official Node 22 runtime, and packs
everything with the installer + `emcp` CLI inside. Because `better-sqlite3`
is a **native module**, cross-building for another CPU is not supported yet:
build arm64 tarballs on an arm64 host (the script refuses cross-arch and
prints the TODO). Upload the `.tar.gz` and `.tar.gz.sha256` (and/or
`checksums.txt`) as assets of a `v<version>` GitHub release — `emcp update`
and `install.sh --version` rely on those names.
