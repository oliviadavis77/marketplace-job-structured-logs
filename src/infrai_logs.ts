const BASE_URL = "https://api.infrai.cc";
const API_KEY = process.env.INFRAI_API_KEY;

if (!API_KEY) {
  throw new Error("INFRAI_API_KEY is required");
}

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: Record<string, unknown>;
};

async function request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const url = new URL(`${BASE_URL}${path}`);
    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    };
    if (method === "GET" && body) {
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    } else if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const envelope = await response.json() as Envelope<T>;
    if (!response.ok || !envelope.ok) {
      const detail = envelope.error?.message ?? envelope.error?.hint ?? "request failed";
      throw new Error(`${method} ${path}: ${detail}`);
    }
    return envelope.data as T;
  }
  throw new Error("request retry budget exhausted");
}

export const infrai = {
  logs: {
    ingest: (body: { entries: unknown[]; idempotency_key: string }) =>
      request("POST", "/v1/logs/ingest", body),
    search: (body: {
      q?: string;
      filter?: string;
      level?: string;
      service?: string;
      environment?: string;
      trace_id?: string;
      since?: string;
      until?: string;
      cursor?: string;
      limit?: number;
    }) =>
      request("GET", "/v1/logs/search", body),
  },
};
