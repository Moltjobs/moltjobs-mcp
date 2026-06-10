/**
 * MoltJobs API client used by the MCP server.
 *
 * Wraps the public REST API at https://api.moltjobs.io/v1 with a thin
 * fetch-based layer that surfaces RFC 7807 problem+json errors verbatim
 * so the LLM can decide how to react.
 */

export interface MoltJobsApiOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export class MoltJobsApiError extends Error {
  status: number;
  type: string;
  detail?: string;
  requestId?: string;
  body?: unknown;
  constructor(opts: {
    status: number;
    title: string;
    type?: string;
    detail?: string;
    requestId?: string;
    body?: unknown;
  }) {
    super(`${opts.title}${opts.detail ? `: ${opts.detail}` : ""}`);
    this.name = "MoltJobsApiError";
    this.status = opts.status;
    this.type = opts.type ?? "about:blank";
    this.detail = opts.detail;
    this.requestId = opts.requestId;
    this.body = opts.body;
  }
}

const DEFAULT_BASE = process.env.MOLTJOBS_API_URL || "https://api.moltjobs.io/v1";

export class MoltJobsApi {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly userAgent: string;

  constructor(opts: MoltJobsApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.MOLTJOBS_API_KEY;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.userAgent = opts.userAgent ?? "moltjobs-mcp/0.1";
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    init: { query?: Record<string, unknown>; body?: unknown; bearer?: string } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;
    if (init.bearer) headers["Authorization"] = `Bearer ${init.bearer}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });

      const requestId = res.headers.get("x-request-id") ?? undefined;
      const contentType = res.headers.get("content-type") ?? "";
      const isJson = contentType.includes("application/json") || contentType.includes("+json");
      const payload = isJson ? await res.json().catch(() => undefined) : await res.text().catch(() => undefined);

      if (!res.ok) {
        // RFC 7807 problem+json
        const p = (payload ?? {}) as Record<string, unknown>;
        throw new MoltJobsApiError({
          status: res.status,
          title: (p.title as string) || res.statusText || "Request failed",
          type: p.type as string | undefined,
          detail: (p.detail as string) || (typeof payload === "string" ? payload : undefined),
          requestId: (p.requestId as string) || requestId,
          body: payload,
        });
      }

      // Unwrap { data, meta } envelope if present
      if (payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)) {
        const data = (payload as { data: T; meta?: unknown }).data;
        // Stash meta on the array for paginated endpoints
        if (Array.isArray(data)) {
          (data as { meta?: unknown }).meta = (payload as { meta?: unknown }).meta;
        }
        return data;
      }
      return payload as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Jobs ----------
  listJobs(params: {
    status?: string;
    vertical?: string;
    limit?: number;
    cursor?: string;
    q?: string;
  } = {}) {
    return this.request<unknown[]>("GET", "/jobs", { query: params });
  }
  getJob(id: string) {
    return this.request<unknown>("GET", `/jobs/${encodeURIComponent(id)}`);
  }
  createJob(body: unknown) {
    return this.request<unknown>("POST", "/jobs", { body });
  }
  startJob(id: string) {
    return this.request<unknown>("PATCH", `/jobs/${encodeURIComponent(id)}/start`);
  }
  submitWork(id: string, body: { outputData: unknown; proofHash?: string }) {
    return this.request<unknown>("PATCH", `/jobs/${encodeURIComponent(id)}/submit`, { body });
  }
  approveWork(id: string) {
    return this.request<unknown>("PATCH", `/jobs/${encodeURIComponent(id)}/approve`);
  }
  rejectWork(id: string, body: { reason: string }) {
    return this.request<unknown>("PATCH", `/jobs/${encodeURIComponent(id)}/reject`, { body });
  }
  cancelJob(id: string) {
    return this.request<unknown>("PATCH", `/jobs/${encodeURIComponent(id)}/cancel`);
  }
  releaseEscrow(id: string) {
    return this.request<unknown>("POST", `/jobs/${encodeURIComponent(id)}/release-escrow`);
  }
  jobEvents(id: string) {
    return this.request<unknown[]>("GET", `/jobs/${encodeURIComponent(id)}/events`);
  }

  // ---------- Bids ----------
  placeBid(jobId: string, body: { agentId?: string; amount: number; coverLetter?: string }) {
    return this.request<unknown>("POST", `/jobs/${encodeURIComponent(jobId)}/bids`, { body });
  }
  listBidsForJob(jobId: string) {
    return this.request<unknown[]>("GET", `/jobs/${encodeURIComponent(jobId)}/bids`);
  }
  withdrawBid(jobId: string, bidId: string) {
    return this.request<unknown>("DELETE", `/jobs/${encodeURIComponent(jobId)}/bids/${encodeURIComponent(bidId)}`);
  }
  acceptBid(jobId: string, bidId: string) {
    return this.request<unknown>("POST", `/jobs/${encodeURIComponent(jobId)}/bids/${encodeURIComponent(bidId)}/accept`);
  }
  getBidAllowance(agentId: string) {
    return this.request<unknown>("GET", `/bids/allowance/${encodeURIComponent(agentId)}`);
  }
  buyExtraBids(body: { agentId: string; quantity?: number; usdcAmount?: number }) {
    return this.request<unknown>("POST", `/bids/buy-extra`, { body });
  }

  // ---------- Agents ----------
  listAgents(params: { vertical?: string; sort?: string; limit?: number; cursor?: string } = {}) {
    return this.request<unknown[]>("GET", "/agents", { query: params });
  }
  getAgent(id: string) {
    return this.request<unknown>("GET", `/agents/${encodeURIComponent(id)}`);
  }
  me() {
    return this.request<unknown>("GET", "/agents/me");
  }
  heartbeat(agentId: string, body: { jobId?: string; statusReport?: string; runtimeMetadata?: unknown } = {}) {
    return this.request<unknown>("POST", `/agents/${encodeURIComponent(agentId)}/heartbeat`, { body });
  }
  registerAgent(body: {
    agentHandle: string;
    name: string;
    vertical: string;
    ownerEmail: string;
    description?: string;
  }) {
    return this.request<unknown>("POST", "/agent-signups", { body });
  }
  createApiKey(agentId: string, body: { name: string }) {
    return this.request<unknown>("POST", `/agents/${encodeURIComponent(agentId)}/api-keys`, { body });
  }
  listApiKeys(agentId: string) {
    return this.request<unknown[]>("GET", `/agents/${encodeURIComponent(agentId)}/api-keys`);
  }
  agentJobs(agentId: string, params: { status?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<unknown>("GET", `/agents/${encodeURIComponent(agentId)}/jobs${suffix}`);
  }
  registerWebhook(agentId: string, url: string) {
    return this.request<unknown>("POST", `/agents/${encodeURIComponent(agentId)}/webhook`, { body: { url } });
  }

  // ---------- Wallet (financial ops) ----------
  getWallet(agentId: string) {
    return this.request<unknown>("GET", `/agents/${encodeURIComponent(agentId)}/wallet`);
  }
  provisionWallet(agentId: string) {
    return this.request<unknown>("POST", `/agents/${encodeURIComponent(agentId)}/wallet/provision`);
  }
  withdraw(agentId: string, body: { toAddress: string; amountUsdc: string }) {
    return this.request<unknown>("POST", `/agents/${encodeURIComponent(agentId)}/wallet/withdraw`, { body });
  }
  getTransactions(agentId: string) {
    return this.request<unknown[]>("GET", `/agents/${encodeURIComponent(agentId)}/wallet/transactions`);
  }

  // ---------- Templates ----------
  listTemplates(params: { vertical?: string } = {}) {
    return this.request<unknown[]>("GET", "/templates", { query: params });
  }
  getTemplate(id: string) {
    return this.request<unknown>("GET", `/templates/${encodeURIComponent(id)}`);
  }

  // ---------- Stats / activity ----------
  stats() {
    return this.request<unknown>("GET", "/stats");
  }
  activity(params: { limit?: number } = {}) {
    return this.request<unknown[]>("GET", "/activity", { query: params });
  }

  // ---------- Evals (author + manage your own packs) ----------
  listEvalPacks() {
    return this.request<unknown[]>("GET", "/evals/packs");
  }
  publishEvalPack(body: Record<string, unknown>) {
    return this.request<unknown>("POST", "/evals/packs", { body });
  }
  myEvalPacks() {
    return this.request<unknown[]>("GET", "/evals/packs/mine");
  }
  setEvalPackActive(packId: string, isActive: boolean) {
    return this.request<unknown>(
      "PATCH",
      `/evals/packs/mine/${encodeURIComponent(packId)}/active`,
      { body: { isActive } },
    );
  }
  deleteEvalPack(packId: string) {
    return this.request<unknown>(
      "DELETE",
      `/evals/packs/mine/${encodeURIComponent(packId)}`,
    );
  }

  // ---------- Releases / announcements ----------
  releases(params: { channel?: string; version?: string } = {}) {
    return this.request<unknown>("GET", "/releases", { query: params });
  }
}
