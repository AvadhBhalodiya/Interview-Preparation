---
title: "Monitoring & Logging"
group: "DevOps & Observability"
order: 6
---

# Monitoring & Logging (CloudWatch, Sentry)

> Observability rests on three pillars - metrics, logs, and traces - and no single tool owns all three: CloudWatch and Prometheus track metrics, Sentry catches application exceptions, and OpenTelemetry is the vendor-neutral pipe that carries all of it to any backend.

## What it is
- **Monitoring** is collecting signals and being told when one crosses a line you actually care about.
- **Logging** is the event record you go read *after* something broke, the "why" behind a metric that moved.
- Together they give **observability**: asking new questions about production without shipping new code to answer them.

The three pillars answer different questions, so you want all three:

| Pillar | What it is | Answers | Typical tools |
| --- | --- | --- | --- |
| **Metrics** | Cheap **aggregated numbers** over time - CPU, p99 latency, error rate | Is something wrong **right now**? | CloudWatch, Prometheus |
| **Logs** | Discrete **timestamped events**, ideally structured JSON | **What** actually happened? | CloudWatch Logs, ELK |
| **Traces** | One request's **path across services**, span by span | **Where** did the time go? | OpenTelemetry, X-Ray |

> [!KEY] Metrics tell you *something* is wrong. Logs and traces tell you *why*. A wall of green dashboards is not observability, it is one pillar out of three.

## Key points
No single tool owns every pillar, so know the four you should be able to place in an interview:

| Tool | Pillar | Model | Reach for it when |
| --- | --- | --- | --- |
| **CloudWatch** | Metrics, logs, alarms | AWS-native, metrics **pushed** in | You live on AWS and want infra metrics and alarms with no extra infra |
| **Prometheus** | Metrics | **Pull**: scrapes `/metrics` on a fixed interval | You want open-source, PromQL, self-hosted metrics (usually with Grafana) |
| **Sentry** | Errors | SDK captures **exceptions** in-app | You need the stack trace, release, and user behind an error spike |
| **OpenTelemetry** | All three | **Vendor-neutral** SDK + Collector, OTLP wire format | You want to instrument once and export anywhere |

- **CloudWatch is the AWS-native plumbing.** A metric is identified by name, namespace, and up to **30 dimensions**, each data point stamped with a time and an optional unit. Log groups and streams hold your raw lines. Alarms watch a metric (or a math expression over metrics) against a threshold across a number of evaluation periods.
- **Three alarm states: OK, ALARM, INSUFFICIENT_DATA.** A new alarm starts in INSUFFICIENT_DATA and drops back there whenever the metric stops reporting. It fires its action only when the state *changes*, not every period the threshold is breached. The one exception: an EC2 Auto Scaling action re-fires while the alarm holds. An alarm can notify an **SNS topic** (which fans out to email, Slack, PagerDuty, Lambda), drive **EC2 Auto Scaling**, or open a **Systems Manager OpsItem**. Wrap flapping alarms in a composite alarm and page only on the composite.
- **Prometheus pulls, it does not wait to be pushed.** The server scrapes each target's `/metrics` endpoint on a schedule you control, so a dead instance is a failed scrape - an instant health signal. Apps expose metrics directly or through an **exporter**, and short-lived batch jobs that cannot be scraped push to a **Pushgateway** instead. Query and alert with **PromQL**.
- **OpenTelemetry (OTel) is the vendor-neutral standard.** One SDK instruments your code, the **Collector** receives and fans out, and **OTLP** (over gRPC or HTTP) is the wire format. Instrument once and swap backends - Jaeger, Tempo, Datadog, CloudWatch - without touching app code.
- **Sentry lives at the application layer.** It captures the exception with a full stack trace, request and user context, folds duplicate errors into one issue, ties each to a release, and alerts on new or regressed errors. CloudWatch tells you the error rate jumped. Sentry tells you it is a `KeyError` on line 47 hitting logged-in users since v2.3.1. Run both.
- **Structured logging beats free text.** Emit one **JSON object per event** with a consistent level and a correlation/request id threaded through every line, so you can lift one request out of the pile. Standard levels run low to high severity, and picking the right one is what lets alerts filter later:

| Level | Use for |
| --- | --- |
| `DEBUG` | Verbose detail for diagnosis, usually **off in prod** |
| `INFO` | Normal lifecycle events - request served, job finished |
| `WARNING` | Unexpected but **handled**, worth a glance |
| `ERROR` | An operation **failed** - a request or job did not complete |
| `CRITICAL` | The app or a subsystem is **going down** |

> [!TIP] Log JSON in prod, pretty-print locally. A `req_id` (or an OTel trace id) on every line is what turns "grep the logs" into "pull up this one request end to end."

## Example
```python
import sentry_sdk
# DSN points the SDK at your project. Sample a fraction of traces, not all.
sentry_sdk.init(dsn=SENTRY_DSN, traces_sample_rate=0.1)

import logging, json
log = logging.getLogger("app")
# one JSON object per event, with a level and a request id you can correlate on.
log.info(json.dumps({"event": "order_paid", "level": "INFO", "order_id": 42, "req_id": rid}))
```

Your app writes to stdout/stderr and the Docker logging driver decides where that lands:

| Driver | Rotates by default? | `docker logs` reads it? | Notes |
| --- | --- | --- | --- |
| `json-file` (**default**) | **No** - set `max-size`/`max-file` or it fills the disk | Yes | Plain JSON, one file per container |
| `local` | **Yes** - 5 files x 20MB, compressed | Yes | Docker's recommended local driver, more compact |
| `awslogs` | Ships to CloudWatch | Only via **dual-logging cache** | Needs `awslogs-group`, plus `awslogs-region` |

```yaml
# compose.yaml - decide where each service's stdout/stderr ends up
services:
  api:
    image: myorg/api:latest
    logging:
      driver: "json-file"     # default: does NOT rotate on its own
      options:
        max-size: "10m"       # numeric/bool values must be quoted here
        max-file: "3"         # without these two, json-file fills the disk
    # to ship straight to CloudWatch, swap the block above for:
    #   driver: "awslogs"
    #   options: { awslogs-region: "us-east-1", awslogs-group: "/myorg/api" }
```

## Interview Q&A
- **The three pillars of observability?** Metrics (aggregated numbers, "is it broken now"), logs (discrete events, "what happened"), traces (request path across services, "where did the time go").
- **CloudWatch vs Prometheus, the core difference?** CloudWatch is AWS-native and metrics are **pushed** to it. Prometheus is open-source and **pull**-based: it scrapes each target's `/metrics` on a schedule, so a failed scrape is an instant health signal.
- **CloudWatch vs Sentry, when each?** CloudWatch for infrastructure and system health (metrics, log groups, alarms). Sentry for application exceptions with stack trace plus release and user context. Little overlap, so most teams run both.
- **What problem does OpenTelemetry solve?** Vendor lock-in. Instrument once with the OTel SDK and export anywhere over OTLP, swapping Jaeger for Datadog without touching app code.
- **CloudWatch alarm states, and when does it act?** OK, ALARM, INSUFFICIENT_DATA. It acts on a state *change*, not every breaching period. Auto Scaling actions are the exception and re-fire while the alarm holds.
- **Container logs are filling the host disk. Why, and the fix?** The default `json-file` driver does not rotate. Set `max-size`/`max-file` or switch to the `local` driver.

## Gotchas
> [!WARN] `json-file` (the default driver) **never rotates on its own** - one chatty container can fill the host disk overnight. Cap it with `max-size`/`max-file`, or switch to the `local` driver, which rotates by default.

> [!WARN] A CloudWatch alarm fires only on a state *change*, not every breaching period. And an alarm parked in INSUFFICIENT_DATA usually means the metric **stopped publishing**, not that all is well, so set the "treat missing data" behaviour explicitly.

- Switch to `awslogs` and `docker logs` still works, but only against the **dual-logging cache** - on by default since Engine 20.10, a ring buffer of 5 files x 20MB that drops the oldest lines under load. It is a recent window, not full history. The authoritative copy is in CloudWatch, and setting `cache-disabled` makes `docker logs` go silent.
- CloudWatch Logs ingestion and custom `PutMetricData` both bill by **volume**. Sample traces, batch metrics, and do not log a fresh line for every loop iteration.
- **Log everything at one level** (all `INFO`, or `DEBUG` left on in prod) and levels stop meaning anything. Match the level to severity so alerting can filter on `ERROR` and above.
- Alert on **symptoms and SLOs** (error rate, latency, saturation), not on every transient blip, or people learn to ignore the pager.

## Revise next
- [CI/CD pipelines](cicd-pipelines.md)
- [AWS core services](aws-core-services.md) (CloudWatch)
- [Load balancing & auto-scaling](load-balancing-auto-scaling.md) (health/metrics)

*Reviewed against Docker Engine 29 logging drivers, AWS CloudWatch, and Sentry docs, July 2026.*
