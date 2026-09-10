# Contributing

Thanks for helping improve Notes. This guide covers getting a development environment running,
the conventions this codebase follows, and the traps that have bitten people before.

For installing a release, see [HELM.md](HELM.md) or [INSTALL.md](INSTALL.md). For cutting one, see
[RELEASING.md](RELEASING.md).

## Getting started

Prerequisites: Node.js 22, Docker Engine with Compose v2.

```sh
git clone https://github.com/jeffbeagley/notes.git
cd notes
npm ci
cp .env.example .env
```

Set the two required secrets in `.env`. The API refuses to start without them:

```sh
openssl rand -base64 48   # SESSION_SECRET, 32+ characters
openssl rand -base64 18   # DEFAULT_ADMIN_PASSWORD, 12+ characters
```

Then:

```sh
npm run build          # dist/ is gitignored, so build before the first compose up
docker compose up -d
```

The web app is at `http://localhost:5173`, the API at `http://localhost:3000`. Sign in with
`DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD`; you will be forced to change the password.

`.env` is gitignored. Never commit real credentials, and never add a working default for one.

## Repository layout

```
apps/api          Fastify + Prisma backend
apps/web          Vue 3 SPA, built by Vite and served by nginx
prisma            Schema and checked-in migrations
deploy/helm       The published Helm chart
tests             Playwright smoke tests
.github/workflows CI and the tag-driven release pipeline
```

## Development loop

The Compose stack runs the API from compiled output over a bind mount, and the web app as a static
nginx build. Neither hot-reloads, so pick the loop that matches what you are changing.

**Backend changes**

```sh
npm run build --workspace=@notes/api
docker compose restart api
```

**Frontend changes**

```sh
docker compose build web && docker compose up -d web
```

**Faster iteration.** For a tighter loop, run the dev servers directly against the Compose
Postgres and Redis instead:

```sh
docker compose up -d postgres redis
npm run dev --workspace=@notes/api   # tsx watch
npm run dev --workspace=@notes/web   # vite with HMR
```

## Before you open a pull request

```sh
npm run check                                          # tsc + vue-tsc
npm run build
helm lint deploy/helm --values deploy/helm/ci/full-values.yaml
npm run test:e2e                                       # needs the Compose stack running
```

CI runs all of these plus a Trivy image scan and a check that the migrations reproduce the schema.

Set `NOTES_TEST_PASSWORD` when running Playwright against a local stack whose admin password is not
the default. Note that repeated test runs trip the login rate limiter (10 attempts per 5 minutes);
`docker compose restart api` clears the in-memory counter.

## Database changes

Edit `prisma/schema.prisma`, then:

```sh
npm run prisma:migrate      # creates a migration in prisma/migrations
npm run prisma:generate     # regenerates the client
```

Commit the generated migration. CI fails if the migrations do not reproduce the schema.

Migrations run in a Helm `pre-install`/`pre-upgrade` Job while the previous version's pods are still
serving traffic, so **a migration must be backwards compatible with the previous release**. Add a
column before you write to it; drop one a release after you stop reading it.

## Conventions

**Comments.** Write one only when the code cannot say it itself: a non-obvious constraint, a
workaround, or a "why", not a restatement of the next line.

**Frontend.** `apps/web/src/App.vue` is a deliberate single-file monolith. Every route maps to it;
view switching happens through an internal `view` ref and the `syncRoute()` / `open*()` functions
rather than separate route components.

Secondary views reuse the global card chrome — `<article class="tasks">`, or `class="editor"` for
single-document views — which supplies margin, border, shadow, and header styling. Reuse the
existing global classes (`.quiet`, `.task-row`, `.summary-row`, `.task-filters`, `.confirm-dialog`,
`.briefing-content`, `.period-grid`) instead of inventing new card wrappers. Shared drill-down
controls are intentionally global, not scoped, so `PeriodSummaries.vue` and the journal archive can
share them.

**Versioning documents.** Reuse the generic `DocumentVersion` table with its `documentType` enum
rather than adding a per-feature version table.

**Backend.** Routes under `/api/v1` are private by default — the global `preHandler` in
`apps/api/src/app.ts` rejects anything not in `publicApiPaths`. If you add a genuinely public route,
add it to that set explicitly and say why in the PR.

Any route that calls an LLM should pass `llmRouteOptions` so it inherits the stricter rate limit.

## Gotchas

These have each caused a real bug. Please read before touching the relevant area.

**Fastify plugin ordering.** `@fastify/rate-limit` attaches itself through an `onRoute` hook, so it
silently does nothing for routes declared before it finishes loading. `createApp()` is `async` and
`await`s its plugin registrations for this reason. Any other `onRoute`-based plugin has the same
requirement.

**nginx `add_header` inheritance.** A `location` block that declares any `add_header` discards every
`add_header` inherited from its parent. Security headers therefore live in
`apps/web/security-headers.conf` and are `include`d in every location of
`apps/web/default.conf.template`. Add the include to any new location block.

**Date formatting.** When formatting a date-only value with `Intl.DateTimeFormat`, anchor to noon
UTC (`T12:00:00Z`), never midnight — midnight UTC formatted in a timezone behind UTC renders as the
previous day. `formatJournalDate` is the reference implementation.

**Container users.** The API image runs as uid 1000, the web image as uid/gid 101, both with a
read-only root filesystem. Anything that needs to write at runtime needs an explicit writable mount
in the chart, and the pod's `fsGroup` has to match.

**Never hardcode a service hostname.** The web image once baked in `proxy_pass http://api:3000`,
which does not resolve in Kubernetes and stopped nginx from starting. Configuration that differs
between Compose and Kubernetes belongs in an environment variable.

## Changing the Helm chart

- Add every new environment variable to `deploy/helm/templates/configmap.yaml`, document it in
  `deploy/helm/values.yaml` and `HELM.md`, and add it to `.env.example` for Compose users.
- Exercise new values in `deploy/helm/ci/full-values.yaml` so CI renders them.
- No value may default to a working secret, credential, or URL. Fail the render instead.
- Do not bump `version` or `appVersion` in `Chart.yaml`; the release workflow rewrites both from the
  git tag.

## Pull requests

- One logical change per PR. Keep unrelated refactors out.
- Use Conventional Commits for the title: `feat:`, `fix:`, `chore:`, `docs:`.
- Explain the "why" in the description, and note any new configuration or manual upgrade step.
- Flag anything touching authentication, sessions, uploads, or the LLM configuration so it gets a
  closer review.

## Reporting a security issue

Please do not open a public issue. Report vulnerabilities privately through GitHub's
[security advisories](https://github.com/jeffbeagley/notes/security/advisories/new).
