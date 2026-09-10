# Notes

Self-hosted, private multi-user notes and daily journal application.

## Install

Notes is published as an OCI Helm chart and container images on GitHub Container Registry. You do
not need to clone this repository to run it.

```sh
helm install notes oci://ghcr.io/jeffbeagley/charts/notes \
  --version 0.1.0 \
  --namespace notes --create-namespace \
  --values notes-values.yaml
```

- **[HELM.md](HELM.md)** — Kubernetes install, full values reference, and troubleshooting
- **[INSTALL.md](INSTALL.md)** — Docker Compose, for local evaluation
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development setup and conventions
- **[RELEASING.md](RELEASING.md)** — for maintainers

| Artifact | Reference |
| --- | --- |
| Chart | `oci://ghcr.io/jeffbeagley/charts/notes` |
| API image | `ghcr.io/jeffbeagley/notes-api` |
| Web image | `ghcr.io/jeffbeagley/notes-web` |

All artifacts are signed with keyless cosign and carry an SBOM and build provenance.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the build and verify loop, code
conventions, and the gotchas worth knowing before changing the API, the nginx config, or the chart.

## Database

`npm run prisma:deploy` applies checked-in migrations. `npm run seed` creates the initial admin only when no user exists. Use `npm run prisma:generate` after changing the Prisma schema.

## OIDC

Configure generic OIDC in `.env` (or the API deployment environment): `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI`. The redirect URI must be `https://your-host/api/v1/auth/oidc/callback` (locally, `http://localhost:5173/api/v1/auth/oidc/callback`). The API uses confidential authorization code flow with PKCE and sets the resulting application session in an httpOnly cookie.

For Authentik, create an OAuth2/OpenID Provider and Application, use its issuer URL, and register the redirect URI above. For Microsoft Entra ID, register a Web platform redirect URI, use `https://login.microsoftonline.com/<tenant-id>/v2.0` as issuer, and grant `openid profile email` scopes. First OIDC login creates a local `user`; addresses listed in `OIDC_ADMIN_EMAILS` become `admin` users.

## LLM Configuration & OpenAI-Compatible Proxies

The single global LLM configuration is managed by admins via the admin settings API (`PUT /api/v1/admin/llm-config`) or environment defaults:

- `LLM_ENABLED=true`
- `LLM_BASE_URL=https://api.openai.com/v1` (or local proxy URL)
- `LLM_API_KEY=your-api-key`
- `LLM_CHAT_MODEL=gpt-4o-mini`
- `LLM_ALLOWED_HOSTS=` — hostname allowlist for the base URL. Leave empty to permit any public HTTPS
  host; you must list the host to point at a private or in-cluster model server.

### Local / Self-Hosted Examples

Each of these needs its host added to `LLM_ALLOWED_HOSTS`, since private and plain-HTTP endpoints
are otherwise rejected.

1. **vLLM / Local AI Proxy**:
   - `LLM_BASE_URL=http://vllm.internal:8000/v1`
   - `LLM_CHAT_MODEL=meta-llama/Llama-3.2-3B-Instruct`
2. **Ollama (OpenAI compatibility mode)**:
   - `LLM_BASE_URL=http://localhost:11434/v1`
   - `LLM_CHAT_MODEL=llama3.2`
3. **LM Studio**:
   - `LLM_BASE_URL=http://localhost:1234/v1`
   - `LLM_CHAT_MODEL=qwen2.5-coder-7b-instruct`

## OpenAPI Documentation

Set `ENABLE_API_DOCS=true` to publish interactive Swagger UI at `/docs` and the raw OpenAPI 3
specification at `/api/v1/openapi.json`. Both are served **without authentication**, so this is off
by default and should stay off on any internet-facing deployment.