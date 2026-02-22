/**
 * Serena MCP – Cloudflare Workers + Containers entry point
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────────────────────
 *  MCP Client (local)                      Cloudflare edge
 *  ─────────────────   HTTPS + Bearer ──►  ┌─────────────────────────────┐
 *                                          │  Worker (this file)         │
 *                                          │  • validates Bearer token   │
 *                                          │  • routes to named container│
 *                                          └──────────┬──────────────────┘
 *                                                     │ HTTP proxy
 *                                          ┌──────────▼──────────────────┐
 *                                          │  Container (SerenaContainer) │
 *                                          │  python serena-mcp-server   │
 *                                          │  --transport streamable-http│
 *                                          │  --port 8080                │
 *                                          └─────────────────────────────┘
 *
 * Authentication
 * ─────────────────────────────────────────────────────────────────────────────
 *  Every request to /mcp must carry:
 *    Authorization: Bearer <API_TOKEN>
 *
 *  Set the token with:
 *    pnpm wrangler secret put API_TOKEN
 *
 *  The comparison uses HMAC-based constant-time equality to prevent timing
 *  attacks from leaking information about the expected token.
 *
 * Session routing (MCP Streamable-HTTP)
 * ─────────────────────────────────────────────────────────────────────────────
 *  FastMCP generates its own session IDs and returns them via the
 *  Mcp-Session-Id response header. The Worker does NOT use this header for
 *  Durable Object selection because that would break follow-up requests.
 *  Instead it routes by authenticated token:
 *  - legacy single-token mode: one "singleton" container
 *  - multi-token mode: one container per token (stable token-derived route key)
 *
 *  In multi-token mode this provides terminal-level process isolation while
 *  preserving FastMCP session consistency within each token's container.
 *
 * MCP Streamable-HTTP endpoint mapping
 * ─────────────────────────────────────────────────────────────────────────────
 *  POST   /mcp   – JSON-RPC requests and notifications (client → server)
 *  GET    /mcp   – SSE event stream (server → client push)
 *  DELETE /mcp   – terminate the session
 */

import {
  Container,
  getContainer,
  type StopParams,
} from "@cloudflare/containers";

// ── Bindings ─────────────────────────────────────────────────────────────────

interface ContainerInjectedEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  SERENA_R2_STATE_ENABLED?: string;
  SERENA_R2_STATE_PREFIX?: string;
  SERENA_R2_STATE_PARTITION_MODE?: string;
  SERENA_R2_STATE_STRICT?: string;
  SERENA_R2_SNAPSHOT_ENABLED?: string;
  SERENA_R2_SNAPSHOT_PREFIX?: string;
  SERENA_R2_SNAPSHOT_INTERVAL_SECONDS?: string;
  SERENA_R2_SNAPSHOT_RETENTION_COUNT?: string;
}

interface Env extends ContainerInjectedEnv {
  /** Durable Object namespace for SerenaContainer instances */
  SERENA_CONTAINER: DurableObjectNamespace<SerenaContainer>;

  /**
   * Bearer token that MCP clients must supply.
   * Set with: pnpm wrangler secret put API_TOKEN
   */
  API_TOKEN?: string;
  API_TOKENS_JSON?: string;

  /**
   * Container route generation used to derive the named singleton route.
   * Bump this value (for example, gen-2) to force requests onto a
   * brand-new container instance after a deploy/rollout.
   */
  MCP_CONTAINER_ROUTE_GENERATION?: string;
}

// ── Container class ──────────────────────────────────────────────────────────

/**
 * Durable-Object-backed container that runs the Serena Python MCP server.
 * The Worker routes all MCP traffic to one named instance by default.
 */
export class SerenaContainer extends Container<Env> {
  /** Port that Serena's streamable-http server listens on inside the container */
  defaultPort = 8080;

  /**
   * Shut the container down after 15 minutes of inactivity to save resources.
   * On the next request the container will restart transparently; the MCP
   * client will re-establish its session.
   */
  sleepAfter = "15m";

  // Pass R2 snapshot sync settings through to the container process. The
  // entrypoint keeps SERENA_HOME on local disk and uses the R2 S3-compatible
  // API for restore/snapshot sync.
  envVars = {
    SERENA_R2_STATE_ENABLED: this.env.SERENA_R2_STATE_ENABLED ?? "0",
    SERENA_R2_STATE_PREFIX:
      this.env.SERENA_R2_STATE_PREFIX ?? "serena-mcp/default/serena-home",
    SERENA_R2_STATE_PARTITION_MODE:
      this.env.SERENA_R2_STATE_PARTITION_MODE ?? "none",
    SERENA_R2_STATE_STRICT: this.env.SERENA_R2_STATE_STRICT ?? "0",
    SERENA_R2_SNAPSHOT_ENABLED: this.env.SERENA_R2_SNAPSHOT_ENABLED ?? "",
    SERENA_R2_SNAPSHOT_PREFIX: this.env.SERENA_R2_SNAPSHOT_PREFIX ?? "",
    SERENA_R2_SNAPSHOT_INTERVAL_SECONDS:
      this.env.SERENA_R2_SNAPSHOT_INTERVAL_SECONDS ?? "180",
    SERENA_R2_SNAPSHOT_RETENTION_COUNT:
      this.env.SERENA_R2_SNAPSHOT_RETENTION_COUNT ?? "5",
    AWS_ACCESS_KEY_ID: this.env.AWS_ACCESS_KEY_ID ?? "",
    AWS_SECRET_ACCESS_KEY: this.env.AWS_SECRET_ACCESS_KEY ?? "",
    R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID ?? "",
    R2_BUCKET_NAME: this.env.R2_BUCKET_NAME ?? "",
  };

  override onStart(): void {
    console.log("[SerenaContainer] Container started");
  }

  override onStop(_: StopParams): void {
    console.log("[SerenaContainer] Container stopped");
  }

  override onError(error: unknown): void {
    console.error("[SerenaContainer] Container error:", error);
  }
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: "Unauthorized", reason }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="Serena MCP Server"',
    },
  });
}

/**
 * Extract the Bearer token from the Authorization header.
 * Returns null when the header is missing or malformed.
 */
function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !token?.trim()) return null;
  return token.trim();
}

/**
 * HMAC-based constant-time token comparison.
 *
 * A naïve string comparison (===) leaks how many leading characters match via
 * timing differences.  Here we sign a fixed message with both tokens using
 * HMAC-SHA-256 and compare the resulting MACs – both paths execute in roughly
 * the same time regardless of where the strings first differ.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) {
    // Still run the full HMAC path on a to keep constant time.
    // We'll return false after, but we must not short-circuit immediately.
  }

  const enc = new TextEncoder();
  const fixedMsg = enc.encode("serena-mcp-auth-check");

  const importKey = (token: string) =>
    crypto.subtle.importKey(
      "raw",
      enc.encode(token),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

  const [keyA, keyB] = await Promise.all([importKey(a), importKey(b)]);
  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", keyA, fixedMsg),
    crypto.subtle.sign("HMAC", keyB, fixedMsg),
  ]);

  // Compare the two MACs byte-by-byte; timingSafeEqual is available in
  // Cloudflare Workers via the crypto.subtle API (signatures are equal iff
  // the keys were equal).
  if (sigA.byteLength !== sigB.byteLength) return false;

  const va = new Uint8Array(sigA);
  const vb = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < va.length; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0 && a.length === b.length;
}

interface AuthCandidate {
  label: string;
  token: string;
}

interface AuthMatch {
  candidate: AuthCandidate;
  routeKey: string;
  mode: "legacy-single-token" | "multi-token";
}

type AuthResult =
  | { ok: true; match: AuthMatch }
  | { ok: false; response: Response };

function internalServerError(reason: string): Response {
  return new Response(JSON.stringify({ error: "Server Misconfigured", reason }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

function parseAuthCandidates(env: Env):
  | { ok: true; candidates: AuthCandidate[]; mode: "legacy-single-token" | "multi-token" }
  | { ok: false; response: Response } {
  const rawMulti = env.API_TOKENS_JSON?.trim();
  if (rawMulti) {
    try {
      const parsed = JSON.parse(rawMulti) as unknown;
      const candidates: AuthCandidate[] = [];

      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          const token = parsed[i];
          if (typeof token !== "string" || token.trim().length === 0) {
            continue;
          }
          candidates.push({ label: `token-${i + 1}`, token: token.trim() });
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [label, token] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof token !== "string" || token.trim().length === 0) {
            continue;
          }
          const safeLabel = label.trim().length > 0 ? label.trim() : "token";
          candidates.push({ label: safeLabel, token: token.trim() });
        }
      } else {
        return {
          ok: false,
          response: internalServerError(
            "API_TOKENS_JSON must be a JSON object or array of strings.",
          ),
        };
      }

      if (candidates.length === 0) {
        return {
          ok: false,
          response: internalServerError(
            "API_TOKENS_JSON is configured but contains no usable tokens.",
          ),
        };
      }

      return { ok: true, candidates, mode: "multi-token" };
    } catch {
      return {
        ok: false,
        response: internalServerError(
          "API_TOKENS_JSON is not valid JSON. Expected object or string array.",
        ),
      };
    }
  }

  const legacyToken = env.API_TOKEN?.trim();
  if (!legacyToken) {
    return {
      ok: false,
      response: unauthorized(
        "No auth secrets configured. Set API_TOKEN or API_TOKENS_JSON.",
      ),
    };
  }

  return {
    ok: true,
    candidates: [{ label: "singleton", token: legacyToken }],
    mode: "legacy-single-token",
  };
}

async function tokenFingerprint(token: string): Promise<string> {
  // The fingerprint is used only for deterministic container routing.
  // It is not an authentication secret and is never accepted as a credential.
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return hex.slice(0, 16);
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthResult> {
  const providedToken = extractBearerToken(request);
  if (!providedToken) {
    return {
      ok: false,
      response: unauthorized(
        'Missing or malformed "Authorization: Bearer <token>" header.',
      ),
    };
  }

  const candidatesResult = parseAuthCandidates(env);
  if (!candidatesResult.ok) {
    return candidatesResult;
  }

  let matched: AuthCandidate | null = null;
  for (const candidate of candidatesResult.candidates) {
    if (await timingSafeEqual(providedToken, candidate.token)) {
      matched = candidate;
      // Do not break early; continue comparisons to reduce timing variance.
    }
  }

  if (!matched) {
    return { ok: false, response: unauthorized("Invalid token.") };
  }

  const routeKey =
    candidatesResult.mode === "legacy-single-token"
      ? "singleton"
      : `tok-${await tokenFingerprint(providedToken)}`;

  return {
    ok: true,
    match: {
      candidate: matched,
      routeKey,
      mode: candidatesResult.mode,
    },
  };
}

// ── CORS helpers ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, mcp-session-id, Accept",
  "Access-Control-Max-Age": "86400",
};

function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function withCors(response: Response): Response {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    r.headers.set(k, v);
  }
  return r;
}

/**
 * Cloudflare Containers currently triggers an internal error when proxying the
 * MCP `notifications/initialized` notification in this deployment, even though
 * the session remains usable afterwards (`tools/list` succeeds). For Serena we
 * can safely acknowledge this notification at the Worker layer and avoid the
 * failing proxy hop.
 */
async function isInitializedNotification(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return false;

  try {
    const payload = (await request.clone().json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }

    const body = payload as Record<string, unknown>;
    return (
      body.jsonrpc === "2.0" &&
      body.method === "notifications/initialized" &&
      !("id" in body)
    );
  } catch {
    return false;
  }
}

function getContainerRouteGeneration(env: Env): string {
  const generation = env.MCP_CONTAINER_ROUTE_GENERATION?.trim();
  return generation && generation.length > 0 ? generation : "gen-1";
}

function getContainerRouteName(env: Env, routeKey = "singleton"): string {
  return `serena-mcp-${routeKey}-${getContainerRouteGeneration(env)}`;
}

function getAuthRoutingMode(env: Env): "legacy-single-token" | "multi-token" {
  // Exposed by /health for quick operational visibility.
  return env.API_TOKENS_JSON?.trim() ? "multi-token" : "legacy-single-token";
}

// ── Main Worker ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── CORS pre-flight ────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return corsPreflightResponse();
    }

    // ── Public health check (no auth required) ─────────────────────────────
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "serena-mcp",
          containerRouteGeneration: getContainerRouteGeneration(env),
          routeStrategy: getAuthRoutingMode(env),
          routeNameTemplate:
            "serena-mcp-<route-key>-" + getContainerRouteGeneration(env),
          r2StateEnabled: (env.SERENA_R2_STATE_ENABLED ?? "0") === "1",
          r2BucketName: env.R2_BUCKET_NAME ?? null,
          r2StatePrefix: env.SERENA_R2_STATE_PREFIX ?? null,
          r2StatePartitionMode: env.SERENA_R2_STATE_PARTITION_MODE ?? "none",
          r2SnapshotIntervalSeconds:
            env.SERENA_R2_SNAPSHOT_INTERVAL_SECONDS ?? "180",
          r2SnapshotRetentionCount:
            env.SERENA_R2_SNAPSHOT_RETENTION_COUNT ?? "5",
          r2StateStrict: (env.SERENA_R2_STATE_STRICT ?? "0") === "1",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Authenticate every other route ─────────────────────────────────────
    const authResult = await authenticateRequest(request, env);
    if (!authResult.ok) {
      return authResult.response;
    }

    // ── MCP endpoint (Streamable-HTTP transport) ───────────────────────────
    //
    // FastMCP manages its own session IDs internally and returns them via the
    // Mcp-Session-Id response header on initialize.  We must NOT use that
    // client-echoed header to select different Durable Objects – doing so
    // would route follow-up requests to a brand-new empty container that has
    // no knowledge of the session, causing "No valid session ID" errors.
    //
    // For the legacy single-token mode, every /mcp request goes to one named
    // container ("singleton"), ensuring FastMCP's in-process session table is
    // always reachable.
    //
    // For multi-token mode (`API_TOKENS_JSON`), the Worker derives a stable
    // route key from the authenticated token and routes each token to a
    // different container. This gives terminal-level process isolation while
    // keeping session consistency within each token's container.
    //
    // The route generation is configurable via MCP_CONTAINER_ROUTE_GENERATION.
    // Bumping it is a safe way to force traffic onto a fresh container
    // instance when a previous instance is still warm during an image rollout.
    //
    // For true multi-tenant isolation (one container per user) a KV-backed
    // session→container mapping would be needed; that is a future enhancement.
    if (url.pathname.startsWith("/mcp")) {
      try {
        if (await isInitializedNotification(request)) {
          console.warn(
            "[Worker] Acknowledging notifications/initialized at edge " +
              "(container proxy compatibility shim)",
          );
          return withCors(new Response(null, { status: 202 }));
        }

        const container = getContainer(
          env.SERENA_CONTAINER,
          getContainerRouteName(env, authResult.match.routeKey),
        );

        const response = await container.fetch(request);
        return withCors(response);
      } catch (err) {
        console.error("[Worker] Container proxy error:", err);
        return new Response(
          JSON.stringify({
            error: "Container unavailable",
            detail: String(err),
          }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // ── 404 fallback ───────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        error: "Not Found",
        hint: "The MCP endpoint is at /mcp",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },
};
