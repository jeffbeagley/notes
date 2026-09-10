# Installing Notes on Kubernetes

Notes is published as an OCI Helm chart and two container images on GitHub Container Registry. You
do not need to clone this repository to install it.

| Artifact | Reference |
| --- | --- |
| Chart | `oci://ghcr.io/jeffbeagley/charts/notes` |
| API image | `ghcr.io/jeffbeagley/notes-api` |
| Web image | `ghcr.io/jeffbeagley/notes-web` |

## Requirements

- Kubernetes 1.25 or newer
- Helm 3.8 or newer (OCI registry support)
- A PostgreSQL 14+ database and a Redis 7+ instance
- A `ReadWriteOnce` storage class for uploaded images
- An ingress controller and TLS certificate

The chart does **not** install PostgreSQL or Redis by default. Optional Bitnami subcharts are
available for evaluation (see [Bundled dependencies](#bundled-dependencies)), but you should point
the chart at a managed database for anything you care about.

## Quick start

Create `notes-values.yaml`:

```yaml
ingress:
  enabled: true
  className: nginx
  host: notes.example.com
  tls:
    enabled: true
    secretName: notes-tls

secrets:
  databaseUrl: postgresql://notes:CHANGE-ME@postgres.internal:5432/notes?schema=public
  redisUrl: redis://redis.internal:6379
  # openssl rand -base64 48
  sessionSecret: "PASTE-A-48-BYTE-RANDOM-VALUE-HERE"
  # Seeds the first admin. Minimum 12 characters. You are forced to change it at first sign-in.
  defaultAdminPassword: "a-strong-bootstrap-password"

persistence:
  storageClass: your-storage-class
  size: 20Gi
```

Install:

```sh
helm install notes oci://ghcr.io/jeffbeagley/charts/notes \
  --version 0.1.0 \
  --namespace notes --create-namespace \
  --values notes-values.yaml
```

Always pin `--version`. Sign in as `admin` with the password you set; you will be required to
change it immediately, which also revokes every existing session.

### Using an existing Secret

Preferred if you manage secrets with External Secrets, SOPS, or Sealed Secrets. Create a Secret
with these keys, then set `secrets.existingSecret` to its name and omit every other `secrets.*`
value:

| Key | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `SESSION_SECRET` | yes | 32+ characters. Signs session cookies. |
| `DEFAULT_ADMIN_PASSWORD` | yes | 12+ characters. Only used when the database has no users. |
| `OIDC_CLIENT_SECRET` | if OIDC | |
| `LLM_API_KEY` | if LLM | |

```sh
kubectl -n notes create secret generic notes-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=DEFAULT_ADMIN_PASSWORD="$(openssl rand -base64 18)"
```

`SESSION_SECRET` is the one value you must not lose or rotate casually — changing it signs every
user out. When the chart generates it for you, it is preserved across upgrades by reading the
existing Secret.

## Verifying artifacts

Every image and chart is signed with keyless cosign. Images also carry an SBOM and build provenance.

```sh
cosign verify ghcr.io/jeffbeagley/notes-api:0.1.0 \
  --certificate-identity-regexp '^https://github.com/jeffbeagley/notes/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Configuration

### Images

| Value | Default | Description |
| --- | --- | --- |
| `api.image.repository` | `ghcr.io/jeffbeagley/notes-api` | |
| `api.image.tag` | chart `appVersion` | Override only to pin a different build |
| `api.image.digest` | `""` | `sha256:...`; takes precedence over the tag |
| `api.replicas` | `1` | See [Scaling](#scaling) before raising this |
| `web.image.repository` | `ghcr.io/jeffbeagley/notes-web` | |
| `web.image.tag` | chart `appVersion` | |
| `web.image.digest` | `""` | |
| `web.replicas` | `1` | Stateless; safe to scale |
| `imagePullSecrets` | `[]` | Only needed for a private mirror |

### Application

| Value | Default | Description |
| --- | --- | --- |
| `config.secureCookies` | `true` | Marks session cookies `Secure`. Set to `false` **only** for a plain-HTTP trial cluster — browsers drop Secure cookies over HTTP and sign-in fails silently. |
| `config.trustProxy` | `true` | Reads `X-Forwarded-*`. Set to `false` only if clients reach the API with no proxy in front. |
| `config.enableApiDocs` | `false` | Publishes **unauthenticated** Swagger UI at `/docs`. Leave off when internet-facing. |
| `config.logLevel` | `info` | pino level |
| `config.mediaRoot` | `/data/media` | Mount path for uploads |
| `config.bodyLimitBytes` | `2097152` | JSON request cap. Image uploads have a separate 10 MB limit. |
| `config.shutdownTimeoutSeconds` | `15` | The pod grace period is this plus 10s |
| `config.rateLimit.max` | `600` | Requests per window per client IP |
| `config.rateLimit.window` | `1 minute` | |
| `config.rateLimit.authMax` | `10` | Per 5 minutes, on login and password change |
| `config.rateLimit.llmMax` | `30` | Per minute, on every LLM-backed endpoint |

Rate limits are per API pod, keyed by client IP. With `trustProxy` disabled, every request appears
to come from your ingress controller and the limits become effectively global.

### Storage

| Value | Default | Description |
| --- | --- | --- |
| `persistence.enabled` | `true` | |
| `persistence.existingClaim` | `""` | Use your own PVC instead |
| `persistence.size` | `10Gi` | |
| `persistence.storageClass` | `""` | Cluster default |
| `persistence.accessModes` | `[ReadWriteOnce]` | |

The media PVC is annotated `helm.sh/resource-policy: keep`, so `helm uninstall` leaves user uploads
in place. Delete it manually if you really want the data gone.

### Ingress

| Value | Default |
| --- | --- |
| `ingress.enabled` | `false` |
| `ingress.className` | `""` |
| `ingress.host` | `notes.example.com` |
| `ingress.tls.enabled` | `false` |
| `ingress.tls.secretName` | `""` |
| `ingress.annotations` | `nginx.ingress.kubernetes.io/proxy-body-size: 10m` |

`/api` routes to the API service and everything else to the web service. Keep the body-size
annotation (or your controller's equivalent) or image uploads fail at 1 MB with an HTML error page.

Without an ingress the web pod still proxies `/api` internally, so a port-forward works:

```sh
kubectl -n notes port-forward svc/notes-notes-web 8080:80
```

### OIDC

| Value | Default | Description |
| --- | --- | --- |
| `oidc.enabled` | `false` | |
| `oidc.issuerUrl` | `""` | Required when enabled |
| `oidc.clientId` | `""` | Required when enabled |
| `oidc.redirectUri` | `""` | Required when enabled. Must be `https://<host>/api/v1/auth/oidc/callback`. |
| `oidc.scopes` | `openid profile email` | |
| `oidc.adminEmails` | `""` | Comma-separated. Grants admin on first login only. |
| `secrets.oidcClientSecret` | `""` | Omit for a public client |

`redirectUri` is mandatory because deriving it from the request `Host` header would let an attacker
steer the OIDC flow. Only email addresses your IdP reports as verified are accepted.

### AI assistant

| Value | Default | Description |
| --- | --- | --- |
| `llm.enabled` | `false` | |
| `llm.baseUrl` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `llm.chatModel` | `gpt-4o-mini` | |
| `llm.embeddingsModel` | `""` | |
| `llm.allowedHosts` | `""` | Comma-separated hostname allowlist for `baseUrl` |
| `secrets.llmApiKey` | `""` | |

The base URL is also editable by admins at runtime. To prevent an admin account from pointing the
server at an internal endpoint and leaking the API key, non-HTTPS and private-range hosts are
rejected unless you list them in `llm.allowedHosts`. To use an in-cluster model server:

```yaml
llm:
  enabled: true
  baseUrl: http://vllm.ai.svc.cluster.local:8000/v1
  allowedHosts: vllm.ai.svc.cluster.local
```

**Enabling this sends the contents of users' notes and journals to the configured provider.**

### Security context and network policy

`podSecurityContext` and `securityContext` default to non-root, read-only root filesystem, all
capabilities dropped, and `RuntimeDefault` seccomp — compatible with the `restricted` Pod Security
Standard. Both are overridable.

`networkPolicy.enabled` (default `false`) restricts API egress to DNS, 5432, and 6379. Add rules to
`networkPolicy.extraEgress` if you enable OIDC or an external LLM provider, or the API will not be
able to reach them.

### Bundled dependencies

For evaluation only:

```yaml
postgresql:
  enabled: true
  auth:
    password: "a-strong-password"
redis:
  enabled: true
```

The chart then builds `DATABASE_URL` and `REDIS_URL` for you and ignores `secrets.databaseUrl` and
`secrets.redisUrl`. These are Bitnami subcharts; their image availability and licensing are outside
this project's control, and neither is configured for backup or high availability. Use a managed
database in production.

## Upgrading

```sh
helm upgrade notes oci://ghcr.io/jeffbeagley/charts/notes \
  --version 0.2.0 \
  --namespace notes \
  --values notes-values.yaml
```

Database migrations and the first-run seed run in a `post-install`/`pre-upgrade` Job, not in the API
containers. On a fresh install it runs after the release's other resources (including a bundled
postgresql/redis subchart) are created, waiting for the database to accept connections first; the
API/web pods may briefly crash-loop until it finishes. On an upgrade it runs as `pre-upgrade`,
before any new API pod starts, so schema changes land first and the upgrade aborts before rolling
out new pods if it fails. Inspect it with:

```sh
kubectl -n notes logs job/notes-notes-migrate-<revision>
```

Set `migrations.enabled: false` only if you run `prisma migrate deploy` yourself.

Take a database backup before upgrading. Migrations are not automatically reversible.

## Scaling

`web.replicas` is safe to raise — the web pods are stateless.

`api.replicas` above `1` requires a `ReadWriteMany` storage class, because all API pods must see the
same uploaded media. Sessions are stateless HMAC cookies and the job queue is in Redis, so nothing
else prevents multiple API replicas.

## Troubleshooting

**Sign-in appears to succeed but immediately returns to the login page.** The session cookie is
being dropped. Either serve the app over HTTPS, or set `config.secureCookies: false` for a
plain-HTTP trial.

**API pods `CrashLoopBackOff` with `SESSION_SECRET is required`.** `secrets.sessionSecret` is empty
or under 32 characters, or your `existingSecret` is missing the key.

**Readiness never passes.** `/readyz` checks PostgreSQL and Redis. Check the connection strings and
any `NetworkPolicy`:

```sh
kubectl -n notes exec deploy/notes-notes-api -- wget -qO- localhost:3000/readyz
```

**`429 Too Many Requests` under normal use.** Either raise `config.rateLimit.max`, or check that
`config.trustProxy` is `true` and your ingress forwards `X-Forwarded-For` — otherwise all users
share one bucket.

**Image uploads fail with an HTML error.** The ingress body-size limit is too low. Restore
`nginx.ingress.kubernetes.io/proxy-body-size: 10m` or your controller's equivalent.

**Migration Job fails on upgrade.** Read its logs, fix the database, then re-run `helm upgrade`.
The Job is recreated on each attempt.
