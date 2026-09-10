# Install Notes with Docker Compose

This guide runs Notes locally with Docker Compose for evaluation and development. It starts the
API, web UI, PostgreSQL 16, Redis 7, and persistent volumes for the database and uploaded media.

For a real deployment, use the published Helm chart instead — see [HELM.md](HELM.md).

## Prerequisites

- Docker Engine with Docker Compose v2
- Ports `3000`, `5173`, `5432`, and `6379` available on the host

## Start the application

1. Create the environment file:

   ```sh
   cp .env.example .env
   ```

2. Set the two required secrets in `.env`. Compose refuses to start without them.

   ```sh
   # SESSION_SECRET - at least 32 characters
   openssl rand -base64 48

   # DEFAULT_ADMIN_PASSWORD - at least 12 characters
   openssl rand -base64 18
   ```

3. Start all services:

   ```sh
   docker compose up --build -d
   ```

4. Confirm that the API is healthy:

   ```sh
   curl --fail http://localhost:3000/healthz
   curl --fail http://localhost:3000/readyz
   ```

Open `http://localhost:5173` to use the application. API documentation is at
`http://localhost:3000/docs` while `ENABLE_API_DOCS=true`.

On first startup, Notes creates the account named by `DEFAULT_ADMIN_USERNAME` with
`DEFAULT_ADMIN_PASSWORD`. You are required to change that password at first sign-in.

> This Compose setup sets `SECURE_COOKIES=false` and `ENABLE_API_DOCS=true` because it serves plain
> HTTP on localhost. Do not expose it beyond a trusted local machine.

## Configuration

Docker Compose loads `.env` for the API service. The following settings are available:

| Setting | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL | Local Compose PostgreSQL |
| `REDIS_URL` | Redis connection URL | Local Compose Redis |
| `HOST` | API bind address | `0.0.0.0` |
| `PORT` | API port | `3000` |
| `NODE_ENV` | Node.js environment | `development` |
| `MEDIA_ROOT` | Directory for uploaded media | `./.data/media` |
| `SESSION_SECRET` | Signs session cookies. 32+ characters. | **Required** |
| `DEFAULT_ADMIN_USERNAME` | Username created when no users exist | `admin` |
| `DEFAULT_ADMIN_PASSWORD` | Password created when no users exist. 12+ characters. | **Required** |
| `SECURE_COOKIES` | Marks session cookies `Secure`. Only `false` for plain-HTTP localhost. | `true` |
| `TRUST_PROXY` | Read `X-Forwarded-*` headers | `true` |
| `ENABLE_API_DOCS` | Publishes unauthenticated Swagger UI at `/docs` | `false` |
| `LOG_LEVEL` | pino log level | `info` |
| `RATE_LIMIT_MAX` | Requests per window per client IP | `600` |
| `RATE_LIMIT_WINDOW` | Rate limit window | `1 minute` |
| `AUTH_RATE_LIMIT_MAX` | Login and password-change attempts per 5 minutes | `10` |
| `LLM_RATE_LIMIT_MAX` | LLM-backed requests per minute | `30` |
| `BODY_LIMIT_BYTES` | Maximum JSON request body | `2097152` |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown budget | `15000` |
| `OIDC_ISSUER_URL` | OIDC issuer URL | Empty; OIDC disabled |
| `OIDC_CLIENT_ID` | OIDC client ID | Empty |
| `OIDC_CLIENT_SECRET` | OIDC client secret | Empty |
| `OIDC_SCOPES` | Requested OIDC scopes | `openid profile email` |
| `OIDC_REDIRECT_URI` | OIDC callback URL | `http://localhost:5173/api/v1/auth/oidc/callback` |
| `OIDC_ADMIN_EMAILS` | Comma-separated addresses granted the admin role at first sign-in | Empty |
| `LLM_ENABLED` | Enables LLM features | `false` |
| `LLM_BASE_URL` | OpenAI-compatible API base URL | `https://api.openai.com/v1` |
| `LLM_API_KEY` | OpenAI-compatible API key | Empty |
| `LLM_CHAT_MODEL` | Chat completion model | `gpt-4o-mini` |
| `LLM_EMBEDDINGS_MODEL` | Optional embeddings model | Empty |
| `LLM_TIMEOUT_MS` | LLM request timeout in milliseconds | `30000` |
| `LLM_MAX_TOKENS` | Maximum generated tokens | `2048` |
| `LLM_ALLOWED_HOSTS` | Comma-separated hostname allowlist for `LLM_BASE_URL`. Required for private or plain-HTTP endpoints. | Empty |

## OIDC

Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI` to enable OIDC. For the Compose deployment, register this callback with the provider:

```
http://localhost:5173/api/v1/auth/oidc/callback
```

The application uses confidential authorization code flow with PKCE. Users listed in `OIDC_ADMIN_EMAILS` are created as administrators on their first OIDC login.

## Stop or remove the installation

Stop services while keeping data:

```sh
docker compose down
```

Remove services and all local database and media data:

```sh
docker compose down --volumes
```

## Kubernetes

For a Kubernetes deployment, see [HELM.md](HELM.md).