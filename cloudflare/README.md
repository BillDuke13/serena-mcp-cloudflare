# Serena MCP – Cloudflare Remote Deployment

Deploy Serena as a **remote MCP server** reachable from any local AI client
(Claude Desktop, Claude Code, Cursor, etc.) via HTTPS.

## Architecture

```
Local MCP client
     │ HTTPS
     │ Authorization: Bearer <token>
     ▼
Cloudflare Worker          (TypeScript proxy + auth layer)
     │ HTTP proxy
     │ route by authenticated token
     ▼
Cloudflare Container       (Python – Serena MCP server)
     │ optional R2 snapshot restore/sync via S3 API
     └─ serena-mcp-server --transport streamable-http --port 8080
```

- **Worker** – Edge function that validates Bearer tokens and routes `/mcp`
  traffic by authenticated token:
  - `API_TOKEN` only: legacy singleton route
  - `API_TOKENS_JSON`: one container route per token (multi-terminal isolation)
- **Container** – Full Python environment running Serena with the
  Streamable-HTTP transport (port 8080). FastMCP manages MCP sessions inside
  that one process. Optionally uses the R2 S3-compatible API (`awscli`) to restore
  and periodically snapshot the local `SERENA_HOME` directory.

## Scope and Design Goals

This project is a deployment wrapper for Serena, not a fork of Serena's core
runtime. It focuses on:

- Cloudflare Workers authentication and request routing
- Cloudflare Containers runtime packaging
- Optional R2 snapshot persistence for `SERENA_HOME`
- Operational guardrails for rollouts and remote MCP compatibility

It intentionally does not replace Serena's native project documentation or
change Serena's core MCP semantics.

## Prerequisites

| Tool | Purpose |
|------|---------|
| [pnpm](https://pnpm.io) | Node package manager |
| [Cloudflare account](https://dash.cloudflare.com) | Workers Paid plan (required for Containers) |
| Docker (local, for testing) | Optional – build/test the image locally |

## Quick Start

### 1. Install dependencies

```bash
# From the project root
pnpm install
```

### 2. Authenticate with Cloudflare

```bash
pnpm wrangler login
```

### 3. Set Authentication Token Secret(s)

Choose strong, random tokens. These are the Bearer tokens MCP clients will use.

Single terminal / legacy mode:
```bash
pnpm wrangler secret put API_TOKEN
# enter your token at the prompt – it is stored encrypted in Cloudflare
```

Multi-terminal mode (recommended for concurrent terminals):
```bash
pnpm wrangler secret put API_TOKENS_JSON
```

Paste JSON in this format:
```json
{
  "terminal-a": "replace-with-real-token-a",
  "terminal-b": "replace-with-real-token-b"
}
```

### 4. (Optional but recommended) Enable R2-backed snapshot persistence for `SERENA_HOME`

This deployment keeps `SERENA_HOME` on local container storage and uses the R2
S3-compatible API for startup restore + periodic compressed snapshots.

Suggested bucket name (best-practice style: `app-purpose-env`):

```text
serena-mcp-state-prod
```

Create the bucket:

```bash
pnpm exec wrangler r2 bucket create serena-mcp-state-prod
```

Create an R2 Access API key in the Cloudflare dashboard (R2 -> Manage R2 API Tokens),
then store the generated credentials as Worker secrets:

```bash
pnpm wrangler secret put AWS_ACCESS_KEY_ID
pnpm wrangler secret put AWS_SECRET_ACCESS_KEY
```

Update `wrangler.toml`:

- set `R2_ACCOUNT_ID` to your Cloudflare account ID
- keep `R2_BUCKET_NAME = "serena-mcp-state-prod"` (or your preferred name)
- set `SERENA_R2_STATE_ENABLED = "1"`
- adjust `SERENA_R2_STATE_PREFIX` if you want a different path within the bucket
- keep `SERENA_R2_STATE_PARTITION_MODE = "durable-object"` for multi-terminal isolation
- optionally tune `SERENA_R2_SNAPSHOT_INTERVAL_SECONDS` / `SERENA_R2_SNAPSHOT_RETENTION_COUNT`

### 5. Deploy

```bash
pnpm wrangler deploy
```

After the first deploy, the container image is built and pushed automatically.
Container provisioning takes **a few minutes** on first use.

### 6. Verify deployment

```bash
# Health check (no auth needed)
curl https://serena-mcp.<your-account>.workers.dev/health

# Auth check
curl -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -X POST \
     https://serena-mcp.<your-account>.workers.dev/mcp
```

`/health` now returns routing and persistence metadata (route generation, route
strategy, and R2 snapshot settings), which is useful for rollouts and debugging.

## Connecting a Local Client

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "serena-remote": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
               "https://serena-mcp.<your-account>.workers.dev/mcp",
               "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

### Claude Code (`.claude.json` or via CLI)

```bash
claude mcp add serena-remote \
  --transport http \
  --url https://serena-mcp.<your-account>.workers.dev/mcp \
  --header "Authorization: Bearer <token>"
```

### Direct Streamable-HTTP (any MCP client)

```
URL:     https://serena-mcp.<your-account>.workers.dev/mcp
Auth:    Authorization: Bearer <your-api-token>
Header:  mcp-session-id: <unique-client-id>   (optional – for session isolation)
```

Note: the Worker forwards the `mcp-session-id` header to Serena/FastMCP, but it
does **not** use that header to select a different container instance. Container
routing is based on the authenticated token (legacy singleton or per-token route).

## Useful Commands

```bash
pnpm run deploy              # deploy Worker + Container
pnpm run dev                 # local dev mode (Worker only)
pnpm run containers:list     # list container resources + health/instance counts
pnpm run containers:images   # list container images
pnpm exec wrangler r2 bucket create serena-mcp-state-prod
pnpm exec wrangler r2 bucket info serena-mcp-state-prod
pnpm exec wrangler containers info <CONTAINER_ID>
pnpm exec wrangler containers delete <CONTAINER_ID>   # disruptive fallback
pnpm wrangler secret put API_TOKEN   # rotate the auth token
```

## Open-Source Publishing Notes

If you publish this deployment as a standalone repository, treat the values in
`wrangler.toml` as templates:

- `R2_ACCOUNT_ID` should remain empty in source control
- `R2_BUCKET_NAME` should be a placeholder or suggested name
- `SERENA_R2_STATE_ENABLED` should default to `"0"` unless you want R2 enabled
  out of the box
- all credentials must be configured via `wrangler secret put`

Do not commit:

- `.wrangler/`
- `.serena/memories/`
- local `.env` files
- Cloudflare API tokens or R2 access keys

## Configuration

| `wrangler.toml` key | Default | Description |
|---------------------|---------|-------------|
| `max_instances` | 8 | Maximum concurrent container instances (raise for more token-routed terminals) |
| `SerenaContainer.sleepAfter` | `"15m"` | Idle timeout before container shutdown |
| `MCP_CONTAINER_ROUTE_GENERATION` | `"gen-1"` | Generation string used to derive named container routes; bump to force fresh instances |
| `SERENA_R2_STATE_ENABLED` | `"0"` | Enable (`"1"`) R2 snapshot restore/sync for local `SERENA_HOME` |
| `SERENA_R2_STATE_PREFIX` | `"serena-mcp/default/serena-home-snapshots-v1"` | Prefix (path) inside the R2 bucket used for Serena snapshots |
| `SERENA_R2_STATE_PARTITION_MODE` | `"durable-object"` | Partition R2 snapshot paths per Durable Object/container (recommended for multi-token routing) |
| `SERENA_R2_STATE_STRICT` | `"0"` | If `"1"`, fail container startup when R2 mount/restore fails; otherwise degrade to local-only mode |
| `SERENA_R2_SNAPSHOT_INTERVAL_SECONDS` | `"180"` | Periodic snapshot interval in seconds (`0` disables background snapshots) |
| `SERENA_R2_SNAPSHOT_RETENTION_COUNT` | `"5"` | Number of snapshot archives to keep in R2 |
| `R2_BUCKET_NAME` | `"serena-mcp-state-prod"` | Suggested R2 bucket name for Serena state |
| `R2_ACCOUNT_ID` | `""` | Your Cloudflare account ID for the R2 S3 endpoint |
| `API_TOKEN` | *(secret)* | Legacy single-token auth secret (optional if `API_TOKENS_JSON` is set) |
| `API_TOKENS_JSON` | *(secret)* | JSON object / array of tokens for multi-terminal token routing |

### Container environment variables

Override at deploy time via `wrangler.toml` `[vars]` or container `envVars`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERENA_HOME` | `/app/.serena` | Serena config directory |
| `SERENA_DOCKER` | `1` | Signals to Serena it runs in a container |
| `AWS_ACCESS_KEY_ID` | *(secret)* | R2 Access API key ID (for optional snapshot sync) |
| `AWS_SECRET_ACCESS_KEY` | *(secret)* | R2 Access API secret (for optional snapshot sync) |

## Security Notes

- Bearer token comparison uses **HMAC-SHA-256 constant-time equality** to
  prevent timing-based token enumeration.
- The container is **not directly accessible** from the public internet; all
  traffic flows through the authenticating Worker.
- Token is stored as a **Wrangler secret** (encrypted at rest).
- Rotate the token with `pnpm wrangler secret put API_TOKEN` – no redeploy needed.
- For multi-terminal mode, manage tokens through `API_TOKENS_JSON` and rotate by
  updating that secret (redeploy not required for Worker secret updates).
- If you enable R2 persistence, store R2 API credentials as **Wrangler secrets**
  (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) and scope the R2 API token to
  the specific state bucket.

## Persistence Notes

- This deployment persists Serena state by keeping `SERENA_HOME` on local disk
  and writing compressed snapshots to an R2 bucket prefix via the R2
  S3-compatible API (`awscli`).
- On startup, the entrypoint restores the latest snapshot (if present) before
  launching Serena.
- During runtime, the entrypoint writes periodic snapshots and a best-effort
  shutdown snapshot.
- In multi-terminal mode, snapshots are partitioned per Durable Object ID so
  token-routed containers do not overwrite each other's state.
- Cloudflare documents this as a valid Containers use case ("Persisting user
  state"), but note that object storage is not a POSIX filesystem and should
  not be treated like local SSD storage.
- This snapshot pattern avoids live writes to object storage and is safer than
  mounting `SERENA_HOME` directly on a FUSE-backed object store.

## Troubleshooting

### `notifications/initialized` Returns `202 Accepted`

This deployment intentionally acknowledges MCP
`notifications/initialized` at the Worker layer (`202 Accepted`) as a
compatibility shim. In this environment, proxying that notification to the
container can intermittently trigger a Cloudflare Containers internal error
even when the MCP session remains usable.

This behavior is specific to the deployment wrapper and does not change Serena's
tool behavior after initialization.

### MCP Handshake Fails with HTTP 406 (`Not Acceptable`)

Symptom (common with some Rust MCP clients): the `initialize` request succeeds,
but `notifications/initialized` fails because the client omits the `Accept`
header and FastMCP's Streamable-HTTP validation rejects it with `406`.

This deployment includes a Docker image patch in `Dockerfile.cloudflare` that
makes a missing `Accept` header permissive (RFC 7231 behavior).

If you deploy the patch but still see the old behavior, a warm container
instance may still be serving traffic. Use one of these options:

1. Bump `MCP_CONTAINER_ROUTE_GENERATION` in `wrangler.toml`, then redeploy.
2. Wait for `SerenaContainer.sleepAfter` to expire (`15m` by default).
3. As a disruptive fallback, delete the container via `wrangler containers delete <CONTAINER_ID>` and redeploy.

### MCP Handshake Step 2 Fails with HTTP 503 (`Container unavailable`)

If `initialize` succeeds but `notifications/initialized` fails with `503`, the
container process likely crashed after startup. Common causes include R2 mount
or restore failures.

This deployment defaults to `SERENA_R2_STATE_STRICT = "0"` so R2 problems
should degrade to local-only mode instead of crashing the container. To debug:

1. Check `/health` and confirm the route generation matches the current deploy.
2. Temporarily set `SERENA_R2_STATE_ENABLED = "0"` and redeploy to isolate R2.
3. If needed, enable strict mode (`SERENA_R2_STATE_STRICT = "1"`) to surface
   startup failures deterministically during testing.

### `notifications/initialized` Compatibility Shim

This deployment includes a Worker-side compatibility shim for the MCP
`notifications/initialized` JSON-RPC notification:

- If the request is exactly the `notifications/initialized` notification, the
  Worker returns `202 Accepted` directly instead of proxying it to the
  container.
- This is a deployment-specific workaround for a Cloudflare Containers internal
  error observed on that notification path, while the MCP session itself
  remains usable (`tools/list` and normal requests continue to work).

## Limitations

- Serena containers start with **no pre-loaded project**.  Use the
  `activate_project` tool after connecting, or bake a project into the image.
- Large language-server downloads (e.g., Java, Rust) happen on first use
  inside the container (may add latency).
- Container state is **ephemeral** – language-server caches are lost when the
  container sleeps and restarts.
- R2 snapshots improve Serena config/state continuity but do **not** persist
  FastMCP in-memory session state; clients may still need to re-initialize.
- In legacy single-token mode, authenticated clients share one Serena process.
- In multi-token mode (`API_TOKENS_JSON`), each token is routed to a separate
  container process (terminal-level isolation).
- If R2 persistence is disabled, `SERENA_HOME` remains local to the container
  instance and is lost on restart / sleep / rollout.
