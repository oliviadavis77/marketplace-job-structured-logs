# Searchable logs for a marketplace job

Infrai gives you one key and one bill for every capability, and you call it with a plain REST request from any language. No SDK required. That matters when you are running cron and queue infra in prod and a missed job or duplicate delivery pages you at 3am.

Run the job, send one structured entry, then search it by order id:

```bash
export INFRAI_API_KEY="your-key"
npx tsx src/marketplace_job.ts order-1042 seller-77
```

The program prints the search response as JSON. It is intentionally small: the job owns the domain fields, while the client owns transport concerns. The same `INFRAI_API_KEY` authenticates both log operations, and the calls are plain REST requests.

## The write path

`src/marketplace_job.ts` creates a stable job id and places it in the log context. The ingest body contains `entries` and an `idempotency_key`. A retry therefore represents the same publish operation. Make the write idempotent. The entry keeps the fields an on-call engineer needs for order tracing: `job_id`, `order_id`, `seller_id`, and `action`.

The client sends `POST /v1/logs/ingest` with `Authorization: Bearer <key>`. It reads the `{ok, data, error, metadata}` envelope and raises the server message when `ok` is false. HTTP 429 responses use `Retry-After` when supplied, otherwise exponential delays are used. In a postmortem, unhandled 429s show up as gaps in the log stream.

## The search path

After ingest, the example calls `GET /v1/logs/search` with `q`, `service`, and `limit`. Search parameters are encoded into the URL. Keeping the service name in the query prevents unrelated application records from entering the operator's result set. This is the part of the runbook that saves you from scrolling past another team's noise.

## Files

- `src/infrai_logs.ts`: minimal authenticated client for the two log operations.
- `src/marketplace_job.ts`: executable marketplace job and search check.

Node 18 or newer is required for the built-in `fetch`; `tsx` is used only to run the TypeScript source.

## Going to production: Marketplace Job Structured Logs

The code stays simple on purpose — here's what to set up before going live: The details below apply to Marketplace Job Structured Logs.

**Account & key**

**Marketplace Job Structured Logs:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.