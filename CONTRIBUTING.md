# Contributing to MCP Suite CRM

Thanks for your interest. The project is in its `0.x` phase: architecture is
still settling, so the contribution posture is deliberately narrow for now.

## What's welcome right now

- **Issues and discussions** — bug reports, agent-workflow feedback, docs gaps.
- **Small fixes** — typos, docs corrections, obvious one-file bugfixes.

## What's maintainer-led right now

- Core architecture (operation catalog, policy/approval model, schema).
- New entities, new operations, new transports.
- Anything that changes the shape of `packages/core`.

Open an issue first for anything beyond a small fix; PRs that reshape core
without prior discussion will likely be declined regardless of quality.

## Ground rules for code

1. **Every behavior is an operation.** New features enter through the
   operation catalog (`packages/core/src/operations/`) — never as UI-only or
   MCP-only logic. The web app and MCP server are adapters over the same
   catalog.
2. **DB access only via `packages/db` repositories** implementing the ports in
   `packages/core/src/ports.ts`. No SQL outside `packages/db`.
3. **Schema changes are versioned migrations** (`packages/db/src/migrations/`),
   never edits to the live database or to already-shipped migration files.
4. **Checks must pass**: `make typecheck && make test` (and `make build` if
   you touched the web app).
5. **No new runtime dependencies** without discussion — the dependency budget
   is deliberately small.

## Developer sign-off (DCO)

By contributing you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign your commits with `git commit -s` (adds a `Signed-off-by:` trailer). A
CLA may replace or supplement DCO before 1.0; meaningful code contributions
may be held until you've agreed to whichever is in force.

## License

Contributions are accepted under **AGPL-3.0-only** (see `LICENSE`). Extension
and plugin APIs are unstable until 1.0; there is no compatibility promise
across `0.x` versions.
