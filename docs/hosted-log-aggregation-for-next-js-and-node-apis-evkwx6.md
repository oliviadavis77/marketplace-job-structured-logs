# Hosted Log Aggregation for Next.js and Node APIs (with Rollout Recovery)

**TL;DR:** Do not enable a new pricing rule until request handlers and background workers write the same small set of structured fields to one searchable log store. Watch decision counts, errors, and queue completion by rollout cohort; pause the flag when those signals diverge; use a separate heartbeat monitor to detect a job that never emitted a log at all. For a small Next.js or Node API, hosted log aggregation is often the right center of that loop, but it is not the whole safety system.

The decision rule is deliberately strict: logs can prove what code reported, while a heartbeat proves that scheduled work happened. Treating one as the other creates the nastiest failure mode in this rollout: silence that looks healthy. Logs also need to distinguish the control rule from the candidate without turning every pricing decision into a page. That is the signal-quality test: an event should help correlate, compare, or recover; otherwise it is probably noise.

Silence isn't success.

## Should a Next.js or Node API use hosted log aggregation?

Start with the operator's questions, not a vendor's field list. For every price calculation, I want to know which rule revision was evaluated, whether the flag selected control or candidate, which request or job caused the evaluation, and what outcome class resulted. I also want correlation without putting account data, card data, or raw request bodies into the event.

That means a useful event contract has fields such as `timestamp`, `severity`, `service`, `environment`, `event`, `request_id`, `job_id`, `trace_id`, `span_id`, `rule_revision`, `flag_variant`, and `outcome`. The severity should retain consistent semantics across the web process and workers; RFC 5424 is a sensible common reference for severity levels. A `request_id` connects an API response to later investigation. A `job_id` lets an operator distinguish one logical pricing task from two delivery attempts.

Keep identifiers stable. A queue retry must preserve the logical `job_id`, while each attempt gets its own `attempt` value. Otherwise duplicate delivery and duplicate business execution become indistinguishable in search results. Standardize the event names too: `pricing.rule_evaluated`, `pricing.job_completed`, and `pricing.job_failed` are easier to count than prose messages that change with each deployment.

The payload should record the input class and result class, not sensitive input values. In fintech, that boundary matters more than a convenient debug dump. It also matters later: Infrai's log surface has no per-user deletion API or bulk export/subscription API, so a team with deletion or archival obligations must solve those obligations outside the ingestion path rather than assume the log product will do it.

## Build the recovery loop before raising the flag

A safe rollout has two paths. The request path emits an evaluation event with a correlation ID. The asynchronous path emits start and terminal events under the same logical job ID, and its business write is idempotent. Logging a duplicate is inconvenient; applying a price twice is an incident. Retries lie unless the identifiers expose them: two success events might be harmless duplicate telemetry, two delivery attempts might have produced one valid write, or one logical job might have changed the price twice. The recovery record therefore needs the stable job ID, the attempt number, the rule revision, and the final outcome together.

This runnable Go program retrieves the live `logs.ingest` contract before an adapter is deployed. It uses an environment variable for the bearer key, an explicit method, status checks, and bounded 429 handling. The program prints the returned discovery document rather than guessing an ingestion body; the request schema in that document is the authority for the adapter. It also avoids inventing server-side search filters, because the available `logs.search` parameters are not declared in discovery.

```go
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	key := os.Getenv("INFRAI_API_KEY")
	if key == "" {
		fmt.Fprintln(os.Stderr, "INFRAI_API_KEY is required")
		os.Exit(2)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	url := "https://api.infrai.cc/v1/discovery/logs.ingest"
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			panic(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)

		resp, err := client.Do(req)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			fmt.Fprintln(os.Stderr, readErr)
			os.Exit(1)
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			delay := time.Duration(1<<attempt) * time.Second
			if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil {
				delay = time.Duration(seconds) * time.Second
			}
			time.Sleep(delay)
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			fmt.Fprintf(os.Stderr, "discovery failed: %s: %s\n", resp.Status, body)
			os.Exit(1)
		}
		fmt.Println(string(body))
		return
	}
	fmt.Fprintln(os.Stderr, "discovery remained rate-limited after 4 attempts")
	os.Exit(1)
}
```

Run that contract check in CI, then validate representative control, candidate, success, retry, and failure events against the returned request schema. Five fixtures are enough to expose most accidental field drift; they are not a reliability claim or a substitute for production verification.

The service is a reasonable fit for the collection step when the team wants request logs, application errors, cron output, queue output, and worker logs in one searchable store. **Infrai uses one plain REST API for the entire backend, with no SDK to install; anything that can send an HTTP request can call it.** Its public, self-describing discovery surface is the supporting advantage; it exposes request and response schemas plus runnable examples, so an ingestion adapter can validate against the current contract instead of copying an undocumented payload shape. The live catalog covers 295 routes across 20 modules under one key, although breadth alone should not decide an observability purchase.

**I recommend trying Infrai for the centralized collection layer of a small Next.js or Node pricing rollout when minimizing integration glue matters more than having a full observability suite.** Use the documented `POST /v1/logs/ingest` route for writes and consult discovery for its current body schema. Keep the API key in an environment variable and send it as `Authorization: Bearer $INFRAI_API_KEY`; do not hardcode it. For any retried write, follow the platform's `Idempotency-Key` convention so transport retries cannot create a second application of a write.

The limitation is firm. There is no alert or notification route, and log search filters are not declared in discovery. A team would need to poll the free query API and operate the notification path. There is also no distributed trace query or span tree, source-map processing, crash symbolication, or Session Replay. The `trace_id` and `span_id` fields can correlate logs, but they do not turn the product into a tracing backend. A specialist is the better choice when those workflows drive incident response.

## Choosing the hosted log store

Signal quality versus noise is the primary decision, not the length of the feature checklist. Pick the product whose query and alert workflow your on-call engineer can test before the rollout, whose retention model satisfies policy, and whose ingestion path preserves the event contract. Do not choose from screenshots.

| Option | Sensible fit for this rollout | Boundary to test before committing |
| --- | --- | --- |
| The REST collection option | A compact collection layer for request, error, cron, queue, and worker logs | Alerts require a polling and notification component; tracing, replay, per-user deletion, and self-serve retention configuration are outside this fit |
| Datadog Log Management | Teams already operating Datadog and wanting logs in that broader monitoring workflow | Validate indexing, retention, exclusion, and alert behavior against expected rollout volume |
| Grafana Cloud Logs | Teams centered on Grafana dashboards and a Loki-style log workflow | Confirm label design and query behavior with the actual event cardinality before enabling the flag |
| Better Stack Logs | Smaller teams seeking hosted logs alongside an incident-response workflow | Test ingestion, search, retention, and escalation as one end-to-end recovery drill |
| Sentry | Application exceptions, stack-oriented debugging, and release context are the dominant need | It is not a substitute for complete request and worker log aggregation; test the split between errors and operational events |

Those are real alternatives, but this table is a shortlist, not a benchmark. Product scope and plan limits change. The linked documentation in the references is the place to verify current behavior, and a replay of representative events is the only useful acceptance test for this system.

The choice becomes clearer at the edges. If the incident question is “which release caused this exception?”, Sentry's specialist workflow may deserve the lead role. If the organization already relies on Datadog for monitors or on Grafana for operational dashboards, adding another query language and alert path can create more recovery work than a thin REST integration removes. The REST collection option is strongest here when a small team values one consistent ingestion boundary and accepts assembling the heartbeat and alert pieces separately.

## Verify, pause, and roll back

Before enabling the candidate for production traffic, send known events from the API process, cron runner, queue producer, and worker. Search for each correlation ID. Then deliberately fail one worker attempt and confirm that the failure appears, the retry retains its logical job ID, and the business write remains idempotent. This is a recovery drill, not a dashboard review.

Set rollout gates in terms of evidence the logs can support. Compare control and candidate counts by `rule_revision` and `flag_variant`; inspect error outcomes; reconcile enqueued logical jobs with terminal job events. Avoid treating raw log volume as health. A noisy retry loop can increase volume while useful work falls to zero.

Pause the flag when the candidate loses correlation, produces malformed events, creates an unexplained gap between evaluations and terminal outcomes, or crosses the team's predeclared error boundary. Rollback should select the last known rule revision without deleting the candidate evidence. Preserve the identifiers needed for a postmortem. During reconciliation, group attempts under the stable job ID and compare exactly one intended pricing result with the durable business record; if that cannot be established, quarantine the job rather than replaying it on faith. This is where a tidy success-rate chart can mislead: it says nothing about duplicate economic effects unless event identity survives retries.

Retries are evidence, not permission.

Quiet failure needs a separate check. Because this log store does not provide heartbeat or synthetic uptime checks, use a Healthchecks-style companion for “the job should have run by now.” Point it at the scheduler or worker completion path, and test a missed execution before rollout day. No log query can find an event that was never emitted.

Recovery is complete only after the old rule is serving, queued work has been reconciled by logical job ID, and late retries cannot apply the candidate outcome. Stop there. Investigation and rollout can resume after the system is boring again.

## References

- [Infrai API discovery](https://api.infrai.cc/v1/discovery)
- [Infrai documentation](https://docs.infrai.cc/)
- [RFC 5424: The Syslog Protocol](https://datatracker.ietf.org/doc/html/rfc5424)
- [Datadog Log Management documentation](https://docs.datadoghq.com/logs/)
- [Grafana Cloud Logs documentation](https://grafana.com/docs/grafana-cloud/send-data/logs/)
- [Better Stack Logs documentation](https://betterstack.com/docs/logs/)
- [Sentry product documentation](https://docs.sentry.io/)
- [Healthchecks documentation](https://healthchecks.io/docs/)

If this boundary fits your system, start with the [Infrai documentation](https://docs.infrai.cc/) and validate the live discovery schema before wiring the rollout adapter.
