# Releasing

Releases are cut from git tags. Pushing a `v*.*.*` tag to `main` builds and publishes everything;
there is no manual publish step and no artifact is ever published from a branch.

## What a tag produces

| Artifact | Reference |
| --- | --- |
| Helm chart | `oci://ghcr.io/jeffbeagley/charts/notes` |
| API image | `ghcr.io/jeffbeagley/notes-api` |
| Web image | `ghcr.io/jeffbeagley/notes-web` |
| GitHub Release | Generated notes plus the packaged chart `.tgz` |

Tag `v1.4.2` yields:

- Chart `version: 1.4.2` and `appVersion: "1.4.2"`.
- Image tags `1.4.2`, `1.4`, `1`, and `latest`.
- Cosign keyless signatures on every image and the chart; images also receive an SBOM and build provenance.

A pre-release tag such as `v1.5.0-rc.1` publishes `1.5.0-rc.1` and `1.5` only — it does not move
`latest` or the major tag.

The chart's `appVersion` is what selects the image tag at install time, so users never have to set
`api.image.tag` or `web.image.tag`. The release workflow rewrites `Chart.yaml` in the runner; the
values committed to the repository stay at the development version.

## One-time repository setup

1. **Packages exist and are public.** The first successful release run creates
   `notes-api`, `notes-web`, and `charts/notes` under the org's Packages tab as *private*. Open
   each one, then *Package settings → Change visibility → Public*. Do this once; later releases
   inherit the setting.
2. **Link packages to the repo.** Under each package's settings, confirm *Manage Actions access*
   lists this repository with `Write`. The workflow uses the default `GITHUB_TOKEN`, so no PAT or
   registry secret is required.
3. **Actions permissions.** *Settings → Actions → General → Workflow permissions* must allow
   `id-token: write` (it is granted per-job in the workflow, but the org policy must not block it).
   Keyless cosign signing fails without it.
4. **Branch protection.** Require the `Typecheck and build`, `Helm lint and template`, and
   `Build api image` / `Build web image` checks on `main`.

## Cutting a release

```sh
git switch main
git pull

# 1. Confirm a clean build locally.
npm ci
npx prisma generate
npm run check
npm run build
helm lint deploy/helm --values deploy/helm/ci/full-values.yaml

# 2. Tag. Annotated tags only - the workflow reads the tag name, and lightweight
#    tags make `git describe` output confusing later.
git tag -a v1.4.2 -m "v1.4.2"
git push origin v1.4.2
```

Then watch **Actions → Release**. It runs three jobs in order: `version` → `images` → `chart`,
where `chart` also creates the GitHub Release.

## Pre-release checklist

- [ ] Every new Prisma model change has a matching migration in `prisma/migrations`.
      CI enforces this, but a missing migration is the most expensive thing to discover after a tag.
- [ ] Migrations are backwards compatible with the previous release. The chart runs migrations in a
      `pre-upgrade` hook, so old pods serve traffic against the new schema during a rollout.
- [ ] `deploy/helm/values.yaml` documents any new environment variable, and
      `deploy/helm/templates/configmap.yaml` passes it through.
- [ ] `.env.example` documents the same variable for Docker Compose users.
- [ ] No new value defaults to a working credential, URL, or secret.
- [ ] `HELM.md` reflects any changed or removed value.

## Verifying a published release

```sh
VERSION=1.4.2

# Chart
helm pull oci://ghcr.io/jeffbeagley/charts/notes --version "$VERSION"

# Image signature
cosign verify "ghcr.io/jeffbeagley/notes-api:$VERSION" \
  --certificate-identity-regexp '^https://github.com/jeffbeagley/notes/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# SBOM
cosign download sbom "ghcr.io/jeffbeagley/notes-api:$VERSION"

# Build provenance (attached to the OCI image by Buildx)
cosign download attestation "ghcr.io/jeffbeagley/notes-api:$VERSION"
```

## Fixing a bad release

Published tags are immutable and users may already have pulled them. Do not delete or re-push a tag.

1. Mark the GitHub Release as a pre-release so it stops being the "latest" link.
2. Fix the bug on `main`.
3. Tag the next patch version.

If the bad release is actively dangerous, additionally delete the affected package versions from
the GHCR UI so `helm pull` and `docker pull` fail loudly instead of installing it.

## Version numbering

Chart and application versions move together, so the semantics apply to both:

- **Patch** — bug fixes, dependency bumps, chart template fixes that do not change any value name.
- **Minor** — new features, new chart values with safe defaults, additive migrations.
- **Major** — removed or renamed chart values, migrations that are not backwards compatible, or any
  change requiring manual operator action during upgrade. Document the required steps in the
  release notes.
