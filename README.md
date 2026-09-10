# Notes

Your private workspace for the things worth keeping: notes, daily thinking, open tasks, and the context behind them. Notes is a self-hosted, multi-user application that keeps personal knowledge organized, searchable, and useful over time.

Run it on your own infrastructure with Docker Compose or Kubernetes. Your workspace stays yours; optional AI features use the provider you choose.

## What You Get

### Keep knowledge in a shape that makes sense

- Organize notes into **places** and **notebooks**: work, home, a project, a client, or any structure that fits how you think.
- Add descriptions, icons, colors, and cover images to make a large library easy to scan.
- Move notes, notebooks, and places with drag and drop; keep unfiled notes for ideas that do not need a home yet.
- Switch between compact list and visual grid views, favorite important items, and return to recently viewed or popular work from the home screen.
- Write in rich text or Markdown, with headings, checklists, links, code blocks, syntax highlighting, images, and hidden text spans for sensitive details.
- Tag notes, archive instead of delete, and restore earlier versions when an edit goes sideways.

### Turn daily capture into follow-through

- Start each day with a dedicated journal entry and capture ideas without creating clutter in the main library.
- Create tasks from journals, notes, or an inbox; track them as to do, in progress, done, or cancelled.
- Keep open work visible with task filters and carry unfinished tasks into the next day.
- Get a focused **daily briefing** that draws attention to relevant notes, journals, and open tasks.
- Generate weekly, monthly, quarterly, yearly, or custom-period summaries, then drill into the source material and version history behind them.

### Find the answer, not just the document

- Search across notes, journals, tasks, and titles from one place, with autocomplete for faster recall.
- Ask the optional workspace assistant about your content in plain language. It searches the workspace, follows links between related material, and cites the notes and dates that support its answer.
- Use the assistant in workspace, journal, or note context. It can help draft a note, rewrite selected text, suggest tags, extract tasks, and create or organize content when you approve its actions.
- Review AI rewrites as a diff before applying them, so changes remain deliberate.

### Operate it with confidence

- Create local users with user or admin roles, or connect a generic OIDC provider such as Authentik or Microsoft Entra ID.
- Sessions are httpOnly, signed, and revocable; all `/api/v1` routes are private unless explicitly allowlisted.
- Built-in rate limiting, security headers, password-change enforcement, MIME-verified image uploads, structured logs with sensitive fields redacted, and separate liveness/readiness probes.
- API is backed by PostgreSQL and Redis; user-uploaded media is stored on a persistent volume.

## Install

Notes is published as an OCI Helm chart and container images on GitHub Container Registry. You do not need to clone this repository to run it.

```sh
helm install notes oci://ghcr.io/jeffbeagley/charts/notes \
  --version 0.1.0 \
  --namespace notes --create-namespace \
  --values notes-values.yaml
```

The chart deploys the web app, API, media storage, database migration Job, optional ingress, and production-minded security defaults. It expects PostgreSQL and Redis; use managed services for production or enable the optional bundled subcharts for evaluation.

- **[HELM.md](HELM.md)** - Kubernetes install, full values reference, upgrade guidance, and troubleshooting
- **[INSTALL.md](INSTALL.md)** - Docker Compose for local evaluation
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Development setup and conventions
- **[RELEASING.md](RELEASING.md)** - Maintainer release process

| Artifact | Reference |
| --- | --- |
| Helm chart | `oci://ghcr.io/jeffbeagley/charts/notes` |
| API image | `ghcr.io/jeffbeagley/notes-api` |
| Web image | `ghcr.io/jeffbeagley/notes-web` |

Released images and charts are signed with keyless cosign and include an SBOM and build provenance.

## AI Is Optional

Notes works fully without an AI provider. When enabled, the assistant uses an OpenAI-compatible API of your choice: OpenAI, vLLM, Ollama, LM Studio, or another compatible service.

The configured provider receives the content needed to complete an AI request, including relevant notes and journals. For a private or in-cluster provider, explicitly allow its hostname with `LLM_ALLOWED_HOSTS`.

```dotenv
LLM_ENABLED=true
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_CHAT_MODEL=gpt-4o-mini
LLM_ALLOWED_HOSTS=
```

For example, an in-cluster vLLM deployment needs its hostname allowlisted:

```dotenv
LLM_BASE_URL=http://vllm.internal:8000/v1
LLM_CHAT_MODEL=meta-llama/Llama-3.2-3B-Instruct
LLM_ALLOWED_HOSTS=vllm.internal
```

The global AI configuration can also be managed by an administrator in the application.

## Authentication

Local accounts are ready out of the box. On the first start, Notes creates the administrator named by `DEFAULT_ADMIN_USERNAME` (default: `admin`) and requires a password change on first sign-in.

For centralized sign-in, configure generic OIDC with `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI`. Use a fixed callback URL such as:

```text
https://notes.example.com/api/v1/auth/oidc/callback
```

OIDC uses authorization code flow with PKCE. Verified email addresses listed in `OIDC_ADMIN_EMAILS` receive the administrator role on their first login.

## API Documentation

Set `ENABLE_API_DOCS=true` to serve Swagger UI at `/docs` and the OpenAPI 3 document at `/api/v1/openapi.json`. Both endpoints are unauthenticated, so the chart disables them by default; leave them off on an internet-facing deployment.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, testing commands, migration rules, and the framework-specific details that keep changes consistent.
