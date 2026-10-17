# Install with Docker Compose

Use the repository's Compose file to run the published MCP Suite CRM image.
For installation from source, see [PRODUCTION.md](PRODUCTION.md).

## Prerequisites

- A 64-bit Linux host with an amd64 or arm64 processor.
- Docker Engine with the Docker Compose plugin, and permission to run Docker.
- `curl` to download the Compose file.
- A published image. During pre-release, images may not yet be available.
  See [RELEASING.md](RELEASING.md) for image publication details.
- A Linux filesystem for the `./data` directory.

## Install

Create a directory for the deployment and get the repository's Compose file:

```sh
mkdir mcpsuite
cd mcpsuite
curl -fsSL https://raw.githubusercontent.com/rehanhaider/mcpsuite/main/docker-compose.yml -o docker-compose.yml
docker compose pull
docker compose run --rm --no-deps --user root mcpsuite chown node:node /data
docker compose up -d
docker compose logs mcpsuite
```

The ownership command lets the container's `node` user write to the mounted
`./data` directory. The entrypoint runs this command without database setup;
the normal service start performs setup next.

The `mcpsuite` service uses the `mcpsuite/crm` image from Docker Hub. It serves
the web application, operation API, agent endpoint at `/mcp`, and health check
at `/healthz` on port 2222. Before exposing it to the internet, follow
[Put it behind HTTPS](PRODUCTION.md#put-it-behind-https).

On the first run with an empty `./data`, the entrypoint creates the database,
default workspace, and a pending owner account. The logs print the owner email
and a one-time setup code. The default email is `owner@mcpsuite.local`.
Open `http://localhost:2222/set-password`, enter that email and code, and choose
your password. For a remote host, replace `localhost` with its address.
If you lose the code, use the owner recovery command below.

## Pin an exact version

Compose uses the latest stable release by default. To pin an exact published
version, set `MCPSUITE_VERSION` in a `.env` file next to `docker-compose.yml`.
For example, to pin `0.1.0` once it is published, add this line to `.env`:

```dotenv
MCPSUITE_VERSION=0.1.0
```

Then check the resolved image and apply the pin:

```sh
docker compose config
docker compose pull && docker compose up -d
```

The Compose file reads the pin with:

```yaml
    image: mcpsuite/crm:${MCPSUITE_VERSION:-latest}
```

The example resolves to `mcpsuite/crm:0.1.0`. Release image tags omit the
leading `v` used in Git tags.

## Update

Run this command from the directory that contains `docker-compose.yml`:

```sh
docker compose pull && docker compose up -d
```

With an exact version pinned, first change `MCPSUITE_VERSION` in `.env` to
the new published version. With no pin set, the command pulls `latest`.

## Owner recovery

Run this command while the `mcpsuite` service is running:

```sh
docker compose exec mcpsuite pnpm --filter @mcpsuite/db reset-owner
```

The command prints the owner email, a fresh one-time code, its expiry time,
and the password page URL. For a pending owner, use `/set-password`. For an
active owner, use `/reset-password`; issuing this reset code ends all owner
sessions. Open the page on your deployment, enter the printed email and code,
and choose a new password.

## Data location

Compose mounts `./data` from the deployment directory at `/data` in the
container. The database is `./data/mcpsuite.db`, with SQLite WAL sidecar files
in the same directory. Keep this directory across container updates. See
[Backups](PRODUCTION.md#backups) for database backup guidance.
