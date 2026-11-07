# Contributing to Dockify

Bug reports and pull requests are welcome.
Repository: https://github.com/kedarpixels/Dockify

Report a security problem privately, as `SECURITY.md` says, and not in an issue.

## Set up

You need Node 22.18 or newer and pnpm 11 (`corepack enable` gives you the pinned version).

```
pnpm install
cp .env.example .env            # then set DOCKIFY_MASTER_KEY (openssl rand -base64 32)
pnpm typecheck
pnpm test
```

`apps/web` and `apps/site` are not workspace members. Each has its own install and lockfile:

```
cd apps/web && pnpm install --ignore-workspace
cd apps/site && npm ci
```

`README.md` covers running the api, the worker and the database-backed tests.

## Rules for a change

- Keep it small and on one subject. Say what changed and why in the pull request.
- Add a test for a behaviour you add or fix. Run `pnpm typecheck` and `pnpm test`, plus `npm test`
  and `npm run lint` in `apps/web` or `apps/site` when you touch one.
- `apps/web` and `apps/agent` never import `@dockify/db` or `@dockify/crypto`. The web talks to the
  api; the agent holds no database and no keys.
- `packages/contracts` is the one source of truth for what the API takes and answers. Every route
  needs a policy in `apps/api/src/policy.ts`; a test fails without one.
- A shipped migration never changes. Add a new numbered one in `packages/db/prisma/migrations`.
- Shared UI primitives live in `apps/web`. After editing one, run `node scripts/sync-ui.mjs` in
  `apps/site`.
- Comments explain why, in plain words. Copy shown to people uses no em or en dashes.
- Tests and examples use made-up names and documentation addresses (`203.0.113.x`), never a real
  person, customer or server.

## License

By contributing you agree your work is licensed under the Apache License 2.0, as in `LICENSE`.
