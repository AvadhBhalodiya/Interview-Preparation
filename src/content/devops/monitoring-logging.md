---
title: "Monitoring & Logging"
group: "DevOps & Observability"
order: 6
updated: "July 2026"
---

# Monitoring & Logging with CloudWatch and Sentry

> Understand how to monitor infrastructure, centralize logs, detect application errors, trace slow requests, and build actionable production alerts.

## In short

- **Metrics** measure system health over time (CPU, latency, error rate) for dashboards and threshold alerts; **logs** are timestamped records of what happened for one event; **traces** show where time was spent as a request crosses services — three different questions, three different tools.
- Log in **structured JSON** with stable fields (`timestamp`, `level`, `service`, `request_id`, `trace_id`, `event`) instead of free text — free text can be read once but not queried, aggregated, or alerted on reliably.
- **CloudWatch** owns AWS infrastructure health, centralized container logs, and operational alarms; **Sentry** owns application exceptions, stack traces, issue grouping, and release regressions — use both, with each as the source of truth for its own signals.
- A **correlation ID** (`request_id`, forwarded in headers and queue messages, echoed into logs and Sentry tags) ties one request across the load balancer, API, worker, CloudWatch logs, and Sentry event so an incident can be followed end to end.
- Alert on the **four golden signals** — latency, traffic, errors, saturation — because they are customer-visible symptoms; a lone threshold like `CPU > 80%` is noise, not evidence of real impact.
- Docker containers should write only to `stdout`/`stderr`; the platform (the `awslogs` driver, FireLens) ships that output to CloudWatch — never rely on logs surviving inside a disposable container.
- Control telemetry cost deliberately — explicit log retention, sampled traces, narrow Logs Insights time windows — or the observability stack becomes as expensive as the system it watches.

```mermaid
flowchart LR
    U[Client] --> ALB[Application Load Balancer]
    ALB --> APP[ECS / Docker Application]

    APP --> DB[(RDS / PostgreSQL)]
    APP --> CACHE[(Redis)]
    APP --> QUEUE[SQS / Message Broker]
    QUEUE --> WORKER[Worker Containers]

    APP -- stdout / stderr --> CWL[CloudWatch Logs]
    WORKER -- stdout / stderr --> CWL

    ALB -- service metrics --> CWM[CloudWatch Metrics]
    APP -- custom metrics / OTEL --> CWM
    WORKER -- custom metrics / OTEL --> CWM

    APP -- errors and traces --> SENTRY[Sentry]
    WORKER -- errors and traces --> SENTRY

    CWM --> ALARM[CloudWatch Alarms]
    CWL --> INSIGHTS[Logs Insights]
    ALARM --> NOTIFY[Incident Notifications]
    SENTRY --> DEV[Developer Alerts]
```

**Interview answer:** Instrument the application with structured JSON logs, metrics, and distributed traces, then split responsibility: CloudWatch centralizes AWS infrastructure metrics, container logs, and operational alarms, while Sentry owns application exceptions, stack traces, and release-aware issue grouping. Tie every log line, trace, and Sentry event to a shared `request_id`/`trace_id` so one incident can be followed end to end, and alert on the four golden signals — latency, traffic, errors, saturation — so pages reflect customer impact rather than internal noise.

**Gotcha:** Wiring a CloudWatch 5xx alarm, an error-log alarm, and a Sentry issue-spike alert to the same on-call channel for the same underlying incident. Pick one primary paging signal and treat the rest as diagnostic evidence, or the team gets paged four times for one outage.

---

# 1. Why Monitoring and Logging Matter

A production application can fail even when the code works correctly on a developer machine. Common production problems include CPU or memory exhaustion, containers restarting repeatedly, slow database queries, increased API latency, failed background tasks, third-party API timeouts, unexpected exceptions, disk space exhaustion, traffic spikes, and deployment regressions.

Monitoring and logging help answer different questions:

| Question | Best Signal |
|---|---|
| Is the system healthy? | Metrics |
| What exactly happened? | Logs |
| Which request or service was slow? | Traces |
| Which code line failed? | Sentry error event |
| Should the team be notified? | Alarm or alert |
| Did a deployment introduce the issue? | Release tracking |

A mature production system does not collect data only for historical analysis. It turns telemetry into **actionable signals**.

```mermaid
flowchart TD
    A[Application activity] --> M[Metrics]
    A --> L[Logs]
    A --> T[Traces]
    A --> E[Errors]
    M --> MD[Health and trends]
    L --> LD[Detailed event history]
    T --> TR[Request flow and latency]
    E --> ED[Stack trace and code context]
    MD --> AR[Alerts and response]
    LD --> AR
    TR --> AR
    ED --> AR
```

---

# 2. Observability Fundamentals

**Monitoring** tells us whether predefined conditions are healthy or unhealthy.

**Observability** is the broader ability to understand an internal system state from the telemetry it produces, including conditions that were not predicted in advance.

A practical observability setup normally uses four types of data.

## 2.1 Metrics

A metric is a numeric measurement collected over time, for example:

- CPU utilization: `72%`
- API request count: `4,500 requests/minute`
- Error rate: `2.3%`
- Queue depth: `8,200 messages`
- P95 response time: `780 ms`
- Available memory: `1.4 GB`

Metrics are efficient for dashboards, threshold-based alerts, trend analysis, capacity planning, and service-level objectives.

A metric normally contains a name, timestamp, value, and dimensions, for example:

```text
Name: api_request_duration
Value: 245
Unit: milliseconds
Dimensions:
  environment=production
  service=payments-api
  endpoint=/payments
  method=POST
```

Dimensions make metrics filterable, but excessive high-cardinality dimensions can increase cost and complexity. Avoid using values such as `user_id`, `request_id`, or random UUIDs as metric dimensions.

---

## 2.2 Logs

A log is a timestamped record of an event, for example:

```json
{
  "timestamp": "2026-07-30T13:42:10.456Z",
  "level": "ERROR",
  "service": "payment-api",
  "environment": "production",
  "request_id": "req-82c4",
  "message": "Payment provider request failed",
  "provider": "stripe",
  "status_code": 504,
  "duration_ms": 30005
}
```

Logs are useful for debugging failures, auditing application behavior, inspecting request details, searching specific error codes, investigating incidents, and building log-derived metrics. A good log explains an event without requiring a developer to reproduce the issue.

---

## 2.3 Traces

A trace represents the complete journey of one request across services.

A trace contains multiple **spans**. Each span represents one operation.

```text
POST /checkout                            1,250 ms
│
├── Validate request                         8 ms
├── Query PostgreSQL                        42 ms
├── Call inventory-service                 105 ms
├── Call payment-provider                  920 ms
└── Publish order-created event             35 ms
```

Tracing helps identify slow downstream services, expensive database queries, network latency, repeated calls, dependency bottlenecks, and errors across microservices.

Metrics may show that latency increased. Traces help explain **where the time was spent**.

---

## 2.4 Events and Alerts

An event represents a meaningful state change, such as a deployment completed, an EC2 instance stopped, a container restarted, a new Sentry issue appeared, or an alarm moved to the `ALARM` state.

An alert is a notification generated when a rule or condition is matched.

```mermaid
flowchart TD
    T[Telemetry] --> ER{Rule breached?}
    ER -->|No| N[No notification]
    ER -->|Yes| AL[Alert]
    AL --> EM[Email]
    AL --> SL["Slack / Teams"]
    AL --> PD[PagerDuty]
    AL --> IP[Incident platform]
    AL --> AA[Automated action]
```

The objective is not to alert on every error. The objective is to alert when human attention or automated remediation is required.

---

# 3. Amazon CloudWatch Overview

Amazon CloudWatch is AWS's monitoring and observability service. The AWS services it monitors are introduced in [AWS Core Services](aws-core-services.md).

It can collect and work with:

- AWS service metrics
- Custom application metrics
- Infrastructure metrics
- Application and system logs
- Traces and application signals
- Dashboards
- Metric and composite alarms
- Cross-account observability data

CloudWatch is especially useful for infrastructure and AWS-native workloads: AWS resources such as EC2, ECS, EKS, Lambda, RDS, ALB, and SQS publish directly into it.

---

## 3.1 CloudWatch Metrics

Many AWS services automatically publish metrics to CloudWatch.

Examples:

| AWS Service | Common Metrics |
|---|---|
| EC2 | CPU utilization, network traffic, status checks |
| RDS | CPU, connections, free storage, read/write latency |
| Application Load Balancer | Request count, target response time, HTTP 4xx/5xx |
| ECS | CPU and memory utilization |
| Lambda | Invocations, errors, throttles, duration, concurrency |
| SQS | Visible messages, oldest message age, sent/received count |
| ElastiCache | CPU, memory, evictions, cache hits/misses |
| API Gateway | Count, latency, integration latency, 4xx/5xx |

CloudWatch receives metrics through two main paths:

1. **AWS-vended metrics** generated by AWS services.
2. **Custom metrics** published by applications through CloudWatch APIs or OpenTelemetry-compatible telemetry pipelines.

### Metric terminology

| Term | Meaning |
|---|---|
| Namespace | Logical group of metrics |
| Metric name | Name of the measurement |
| Dimension | Key-value metadata used to filter a metric |
| Statistic | Aggregation such as Average, Sum, Minimum, Maximum |
| Period | Time window used for aggregation |
| Resolution | Frequency at which metric data is stored |
| Unit | Seconds, bytes, count, percent, and so on |

Example custom namespace `MyCompany/Payments`, with metrics such as `PaymentSuccessCount`, `PaymentFailureCount`, and `PaymentProcessingTime`.

### Custom metric example with Boto3

```python
import boto3

cloudwatch = boto3.client("cloudwatch", region_name="ap-south-1")

cloudwatch.put_metric_data(
    Namespace="MyCompany/Payments",
    MetricData=[
        {
            "MetricName": "PaymentProcessingTime",
            "Dimensions": [
                {"Name": "Environment", "Value": "production"},
                {"Name": "Provider", "Value": "stripe"},
            ],
            "Value": 420,
            "Unit": "Milliseconds",
        }
    ],
)
```

For high-throughput systems, avoid calling `PutMetricData` synchronously for every request. Prefer batching, Embedded Metric Format, StatsD, OpenTelemetry, or an agent/collector-based approach.

### High-resolution metrics

CloudWatch supports standard-resolution and high-resolution custom metrics.

High-resolution metrics are useful when sub-minute visibility is necessary, but they can create more data and additional cost. Use them for genuinely fast-changing operational signals, not for every business counter.

---

## 3.2 CloudWatch Logs

CloudWatch Logs centralizes logs from applications, servers, containers, and AWS services.

Core structure:

```text
Log Group
└── Log Stream
    ├── Log Event
    ├── Log Event
    └── Log Event
```

### Log group

A log group represents a logical application or resource category.

Examples:

```text
/aws/ecs/payment-api
/aws/lambda/order-processor
/company/production/nginx
/company/production/celery
```

### Log stream

A stream normally represents one source instance.

Examples:

- ECS task
- Container
- EC2 instance
- Lambda execution environment
- Application process

### Log event

A log event contains:

- Timestamp
- Message
- Optional detected fields

### Retention

Set an explicit retention period for each log group.

Do not leave every log group with indefinite retention unless there is a business, security, or compliance requirement.

A practical policy may look like:

| Environment | Suggested Retention |
|---|---:|
| Local | Local rotation only |
| Development | 7–14 days |
| Staging | 14–30 days |
| Production application logs | 30–90 days |
| Security or audit logs | Based on compliance policy |
| Archived long-term logs | Export or deliver to durable storage |

The correct value depends on legal, operational, and compliance requirements.

---

## 3.3 CloudWatch Logs Insights

CloudWatch Logs Insights is used to interactively search and analyze CloudWatch log data.

A basic query:

```sql
fields @timestamp, @message
| sort @timestamp desc
| limit 50
```

### Find recent errors

```sql
fields @timestamp, level, service, request_id, message
| filter level = "ERROR"
| sort @timestamp desc
| limit 100
```

### Count errors by service

```sql
fields service, level
| filter level = "ERROR"
| stats count(*) as error_count by service
| sort error_count desc
```

### Calculate API latency percentiles

```sql
fields endpoint, duration_ms
| filter event_type = "http_request"
| stats
    count(*) as requests,
    avg(duration_ms) as avg_ms,
    pct(duration_ms, 95) as p95_ms,
    pct(duration_ms, 99) as p99_ms
  by endpoint
| sort p95_ms desc
```

### Find logs for one request

```sql
fields @timestamp, service, level, message, request_id
| filter request_id = "req-82c4"
| sort @timestamp asc
```

### Detect new patterns

CloudWatch Logs Insights supports commands for parsing, pattern analysis, aggregation, comparison, and visualization. Pattern and comparison capabilities are useful during incidents because they help identify unusual or newly appearing log structures.

### Query discipline

Keep the time range as narrow as possible — a narrow range returns results faster, scans less data, reduces query cost, and makes incident analysis easier.

---

## 3.4 CloudWatch Alarms

A CloudWatch alarm evaluates a metric or metric expression over time.

Alarm states:

| State | Meaning |
|---|---|
| `OK` | Condition is not breaching |
| `ALARM` | Condition is breaching |
| `INSUFFICIENT_DATA` | CloudWatch does not have enough data |

Example alarm:

```text
Metric: ALB HTTPCode_Target_5XX_Count
Condition: Sum >= 20
Period: 5 minutes
Evaluation periods: 2
Action: Notify production incident channel
```

This means the alert fires only when the rule is breached for the configured evaluation behavior, instead of reacting to one isolated failure.

Alarms can be static, anomaly-based, or composite. A **static alarm** uses a fixed threshold, such as `CPUUtilization > 80%`. An **anomaly detection alarm** uses the historical behavior of a metric to identify unusual values — useful when traffic changes by time of day, a fixed threshold is too simple, or normal usage has seasonal patterns. A **composite alarm** combines multiple alarms, for example `HighLatencyAlarm AND High5xxAlarm`, to reduce noise when one metric by itself is not enough to indicate a real incident.

### Log-based alarm flow

```mermaid
flowchart TD
    A[Application log] --> B[CloudWatch Log Group]
    B --> C[Metric Filter]
    C --> D[CloudWatch Metric]
    D --> E[CloudWatch Alarm]
    E --> F["SNS / Incident notification"]
```

For example, a metric filter idea: count logs where `level = ERROR and service = payment-api`.

Prefer application-native metrics for important business signals when possible. Log-derived metrics are useful, but tightly coupling alerting to free-form log text is fragile.

---

## 3.5 CloudWatch Dashboards

CloudWatch dashboards provide a visual operational view.

A production dashboard may include:

```text
┌───────────────────────────────────────────────┐
│ Requests/min | Error rate | P95 latency       │
├───────────────────────────────────────────────┤
│ ECS CPU      | ECS memory | Running task count│
├───────────────────────────────────────────────┤
│ DB latency   | Connections| Free storage      │
├───────────────────────────────────────────────┤
│ Queue depth  | Oldest msg | Worker failures   │
└───────────────────────────────────────────────┘
```

Good dashboards answer a specific operational question.

Examples:

- Is the customer-facing API healthy?
- Is the asynchronous processing pipeline keeping up?
- Did the new deployment affect latency?
- Is database capacity becoming a risk?

Avoid dashboards containing dozens of unrelated graphs without clear operational purpose.

---

## 3.6 CloudWatch Agent

The CloudWatch agent can collect metrics, logs, and traces from EC2 instances, on-premises servers, containerized applications, and supported operating systems including Linux and Windows.

It is commonly used to collect metrics not available through basic EC2 monitoring, such as memory utilization, disk usage, swap usage, process metrics, additional network or system metrics, and application log files.

### Important distinction

EC2 publishes CPU-related metrics by default, but operating-system memory and disk-usage metrics normally require an agent or another telemetry collector.

### Simplified agent flow

```mermaid
flowchart TD
    H[EC2 host] --> SM[System metrics]
    H --> APL[Application logs]
    H --> TR[Traces]
    SM --> CA[CloudWatch Agent]
    APL --> CA
    TR --> CA
    CA --> CM[CloudWatch Metrics]
    CA --> CL[CloudWatch Logs]
    CA --> TRD[Trace destination]
```

A CloudWatch agent configuration is JSON and can contain `agent`, `metrics`, `logs`, and `traces` sections. Store and distribute the configuration consistently, for example through infrastructure automation or AWS Systems Manager Parameter Store.

---

## 3.7 Application Signals and OpenTelemetry

CloudWatch Application Signals provides an application-centric view of services and their dependencies. It can help with service health, request volume, faults and errors, latency, service dependencies, performance against service-level objectives, and root-cause analysis.

OpenTelemetry is an open standard for generating and exporting metrics, logs, and traces. A modern architecture can instrument applications with OpenTelemetry and route telemetry to CloudWatch or another compatible backend.

```mermaid
flowchart TD
    A[Application] --> OTEL["OpenTelemetry SDK / Collector"]
    OTEL --> M[Metrics]
    OTEL --> L[Logs]
    OTEL --> T[Traces]
    M --> CW[CloudWatch]
    L --> CW
    T --> CW
```

OpenTelemetry reduces vendor-specific instrumentation and is especially useful in environments containing multiple languages or observability backends.

---

# 4. Sentry Overview

Sentry is a developer-focused debugging and application monitoring platform.

It is strongest when developers need to understand:

- Which exception occurred
- Which code path failed
- How many users or requests are affected
- Which release introduced the problem
- What happened immediately before the error
- Whether the same issue is repeating
- Which transaction or operation is slow

Sentry can work with error monitoring, tracing, performance data, logs, release information, and other debugging context depending on the selected SDK and product configuration.

```mermaid
flowchart TD
    A[Application] --> SDK[Sentry SDK]
    SDK --> EX[Exception]
    SDK --> ST[Stack trace]
    SDK --> RC[Request context]
    SDK --> BC[Breadcrumbs]
    SDK --> TG[Tags]
    SDK --> RL[Release]
    SDK --> TRD[Trace data]
    EX --> SN[Sentry]
    ST --> SN
    RC --> SN
    BC --> SN
    TG --> SN
    RL --> SN
    TRD --> SN
    SN --> IG[Issue grouping]
    SN --> OW[Ownership]
    SN --> AL[Alerts]
    SN --> DW[Debugging workflow]
```

---

## 4.1 Error Monitoring

When an unhandled exception occurs, the Sentry SDK can capture an event containing information such as exception type and message, stack trace, source file and line, HTTP request details, environment, release version, runtime information, tags, breadcrumbs, related trace information, and user or tenant context when intentionally configured.

Sentry groups similar events into an **issue**.

Without grouping, 50,000 repeated exceptions could appear as 50,000 separate alerts. With grouping, developers can see one issue with event count, affected users, first seen time, and last seen time.

### Example issue

```text
Issue: TimeoutError in payment_provider.py
Events: 2,483
First seen: After release 2026.07.30.2
Environment: production
Affected endpoint: POST /payments
Primary tag: provider=stripe
```

---

## 4.2 Tracing and Performance Monitoring

Sentry tracing helps identify slow operations.

A transaction may represent:

- HTTP request
- Background job
- Scheduled task
- Queue consumer
- Frontend page load
- Database-heavy operation

Example:

```text
POST /orders                           1.8 s
├── Authentication                     12 ms
├── PostgreSQL query                   70 ms
├── Inventory API                     310 ms
├── Payment provider                 1,300 ms
└── Publish event                      40 ms
```

Tracing is useful for connecting an exception with the operation in which it occurred.

### Sampling

Capturing every trace in a busy production system can create unnecessary volume.

Use a production sampling strategy based on environment, endpoint, error status, transaction type, traffic volume, and business criticality, for example:

```python
def traces_sampler(sampling_context: dict) -> float:
    transaction_context = sampling_context.get("transaction_context", {})
    name = transaction_context.get("name", "")

    if name.startswith("healthcheck"):
        return 0.0

    if name.startswith("POST /payments"):
        return 0.5

    return 0.1
```

Errors and traces are different data types. A low trace sampling rate should not be treated as permission to ignore critical exception capture.

---

## 4.3 Releases and Environments

Always identify the deployed release. Good release identifiers include a Git commit SHA, Docker image digest, semantic version, or CI/CD build number — for example, `payment-api@2026.07.30.2`.

Use consistent environment names (`development`, `staging`, `production`) and avoid accidental variations such as `prod`, `Production`, or `live`.

Consistent release and environment metadata allows developers to answer:

- Did the issue start after a deployment?
- Does it occur only in production?
- Is the fix already deployed?
- Which version generated the event?

---

## 4.4 Breadcrumbs, Tags, and Context

### Breadcrumbs

Breadcrumbs are a timeline of actions leading to an error.

Example:

```text
12:10:02 User opened checkout
12:10:04 Cart loaded
12:10:06 Coupon validated
12:10:08 Payment request started
12:10:38 Payment provider timed out
12:10:38 TimeoutError captured
```

### Tags

Tags are searchable key-value fields, such as `environment=production`, `service=payment-api`, `region=ap-south-1`, `provider=stripe`, or `tenant_tier=enterprise`. Avoid uncontrolled high-cardinality tags unless there is a clear debugging need.

### Context

Context adds structured details that are useful for debugging.

Example:

```python
sentry_sdk.set_context(
    "payment",
    {
        "provider": "stripe",
        "currency": "INR",
        "retry_count": 2,
    },
)
```

Do not attach passwords, tokens, full card details, session cookies, or unnecessary personal data.

---

# 5. CloudWatch vs Sentry

CloudWatch and Sentry overlap in some areas, but they solve different primary problems.

| Area | CloudWatch | Sentry |
|---|---|---|
| Main strength | AWS infrastructure and operational telemetry | Application errors and developer debugging |
| AWS service metrics | Excellent | Not the primary purpose |
| EC2/ECS/RDS monitoring | Excellent | Limited without custom integration |
| Centralized infrastructure logs | Excellent | Possible for application logs, but not its core historical role |
| Exception grouping | Basic through logs | Excellent |
| Stack traces and code context | Requires application log details | Excellent |
| Release regression visibility | Possible with custom dimensions/events | Built for release-aware issue tracking |
| Distributed tracing | Available through AWS observability features and OpenTelemetry | Strong developer-oriented tracing |
| Alarm actions | Strong AWS integration | Strong issue and workflow alerts |
| Best user | DevOps, SRE, platform and operations teams | Application developers |
| Typical question | “Is the AWS system healthy?” | “Why did this code fail?” |

### Recommended approach

Use both when the application is important enough to require infrastructure and code-level visibility, but do not send every piece of telemetry to every platform without a reason — define which tool is the source of truth for each signal.

---

# 6. Recommended Production Architecture

The architecture diagram in **In short** above shows the common AWS and Docker shape: client through the load balancer and ECS/Docker application, out to RDS, Redis, and SQS, with both the application and its workers shipping logs and metrics to CloudWatch and errors and traces to Sentry.

### Responsibility model

| Layer | Tool | Responsibility |
|---|---|---|
| AWS infrastructure | CloudWatch Metrics | Resource health and capacity |
| Container output | CloudWatch Logs | Centralized operational logs |
| Request flow | OpenTelemetry / CloudWatch / Sentry | Latency and dependency analysis |
| Application exceptions | Sentry | Stack trace, issue grouping, release context |
| Operational paging | CloudWatch alarms | Service health and availability |
| Developer notification | Sentry alerts | New or regressed code issues |
| Incident investigation | Both | Correlated infrastructure and code analysis |

---

# 7. Logging Docker Containers to CloudWatch

A containerized application should normally write logs to `STDOUT` and `STDERR`; the container platform or logging driver is responsible for collecting and forwarding them. Avoid writing only to internal container files because containers are disposable.

```mermaid
flowchart TD
    A[Application] --> SO["STDOUT: informational logs"]
    A --> SE["STDERR: errors"]
    SO --> D[Docker logging driver]
    SE --> D
    D --> CW[CloudWatch Logs]
```

---

## 7.1 Docker Compose with the awslogs Driver

The Docker `awslogs` logging driver sends container output to CloudWatch Logs.

```yaml
services:
  api:
    image: my-company/payment-api:2026.07.30.2
    environment:
      APP_ENV: production
      AWS_REGION: ap-south-1
    logging:
      driver: awslogs
      options:
        awslogs-region: ap-south-1
        awslogs-group: /company/production/payment-api
        awslogs-stream: api-{{.ID}}
        awslogs-create-group: "true"
        mode: non-blocking
        max-buffer-size: 4m
```

### Required permissions

The Docker host or runtime credentials need relevant CloudWatch Logs permissions, commonly `logs:CreateLogStream` and `logs:PutLogEvents`; creating log groups dynamically additionally requires `logs:CreateLogGroup`.

In production, it is often cleaner to create log groups through infrastructure as code and apply retention, encryption, and tags explicitly.

### Blocking vs non-blocking

Docker logging is blocking by default. Non-blocking delivery avoids blocking the application when the logging destination is slow or unavailable, at the cost of dropping logs when the buffer is full:

```text
Blocking mode
+ Better delivery pressure
- Application may block under logging backpressure

Non-blocking mode
+ Protects application responsiveness
- May drop logs when the buffer is full
```

For high-volume production applications, treat logging as a bounded resource. Avoid producing unbounded debug output.

---

## 7.2 Amazon ECS and Fargate

For ECS and Fargate, configure the `awslogs` driver in the task definition.

```json
{
  "family": "payment-api",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "123456789012.dkr.ecr.ap-south-1.amazonaws.com/payment-api:2026.07.30.2",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 8000,
          "protocol": "tcp"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-region": "ap-south-1",
          "awslogs-group": "/aws/ecs/payment-api",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

For ECS, ensure the **task execution role** has the permissions required to deliver container logs.

The resulting stream naming commonly follows the configured prefix and task/container information.

### FireLens

For advanced routing, transformation, filtering, or delivery to multiple destinations, ECS FireLens can be used with Fluent Bit or Fluentd.

Use FireLens when you require features such as multiple log destinations, log enrichment, filtering before delivery, custom parsing, or vendor-neutral routing.

Do not introduce a complex log router when the simple `awslogs` driver fully satisfies the requirement.

---

## 7.3 Docker Log Rotation

When logs remain on the Docker host, configure rotation.

Docker's default `json-file` driver can otherwise consume significant disk space.

Example daemon configuration:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

Or configure it per Compose service:

```yaml
services:
  api:
    image: my-company/payment-api:latest
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Logging configuration changes normally apply to newly created containers. Recreate existing containers after changing the logging driver or rotation policy.

---

# 8. Structured Application Logging

Structured logs are easier to search and aggregate than free-form text.

A weak log only says `Something failed`. A better log explains it in prose: `Payment failed for order 12098 because provider returned timeout`. The best approach is a structured log with explicit fields:

```json
{
  "timestamp": "2026-07-30T13:42:10.456Z",
  "level": "ERROR",
  "event": "payment_provider_failed",
  "message": "Payment provider request timed out",
  "service": "payment-api",
  "environment": "production",
  "release": "2026.07.30.2",
  "request_id": "req-82c4",
  "trace_id": "2ac045d9ef3c4fc5",
  "order_id": "ord-12098",
  "provider": "stripe",
  "duration_ms": 30005,
  "retryable": true
}
```

### Recommended common fields

| Field | Purpose |
|---|---|
| `timestamp` | Event time in UTC |
| `level` | Severity |
| `message` | Human-readable explanation |
| `event` | Stable machine-readable event name |
| `service` | Application or service name |
| `environment` | Development, staging, production |
| `release` | Deployed version |
| `request_id` | Correlates one request |
| `trace_id` | Connects logs to a distributed trace |
| `user_id` | Optional and privacy-reviewed |
| `tenant_id` | Useful in multi-tenant systems |
| `duration_ms` | Operation duration |
| `error_type` | Exception class or error category |

### Log levels

| Level | Use |
|---|---|
| `DEBUG` | Detailed development diagnostics |
| `INFO` | Normal meaningful application activity |
| `WARNING` | Unexpected condition that is recoverable |
| `ERROR` | Operation failed and requires investigation |
| `CRITICAL` | Severe system-level failure |

Do not log normal behavior as `ERROR`, because error metrics and alerts will become noisy.

### Python JSON logging example

```python
import json
import logging
import sys
from datetime import datetime, timezone

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        for field in (
            "service",
            "environment",
            "release",
            "request_id",
            "trace_id",
            "event",
            "duration_ms",
        ):
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)

handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JsonFormatter())

logger = logging.getLogger("payment-api")
logger.setLevel(logging.INFO)
logger.handlers = [handler]
logger.propagate = False

logger.info(
    "Payment request completed",
    extra={
        "service": "payment-api",
        "environment": "production",
        "release": "2026.07.30.2",
        "request_id": "req-82c4",
        "event": "payment_completed",
        "duration_ms": 420,
    },
)
```

### Stable event names

Use stable event identifiers for queries and metrics. Good: `event=payment_failed`, `event=order_created`, `event=webhook_signature_invalid`. Fragile: matching on `message contains "payment could not complete today"` — messages can evolve for readability, but stable event names must remain consistent for dashboards and searches.

---

# 9. Using Sentry in Python Applications

Install the Sentry Python SDK: `pip install sentry-sdk`

Store the DSN in a secret-management solution or environment variable.

```bash
SENTRY_DSN="https://examplePublicKey@o0.ingest.sentry.io/0"
SENTRY_ENVIRONMENT="production"
APP_RELEASE="2026.07.30.2"
```

Never hard-code production secrets in source control.

---

## 9.1 Django

A basic Django setup:

```python
# settings.py

import os
import sentry_sdk

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
    release=os.getenv("APP_RELEASE"),
    send_default_pii=False,
    traces_sample_rate=0.1,
)
```

Sentry's Python SDK integrations can automatically connect with supported frameworks and libraries.

### Production recommendations

- Initialize Sentry once during application startup.
- Set `environment`.
- Set `release`.
- Keep `send_default_pii=False` unless a reviewed requirement exists.
- Configure tracing intentionally.
- Filter known non-actionable exceptions.
- Use a `before_send` hook for redaction and event control.
- Verify source-code integration and release mapping in CI/CD.

### Filtering events

```python
from typing import Any

def before_send(
    event: dict[str, Any],
    hint: dict[str, Any],
) -> dict[str, Any] | None:
    exception = hint.get("exc_info")

    if exception:
        _, error, _ = exception

        # Example: ignore a known client-disconnect exception.
        if error.__class__.__name__ == "ClientDisconnectedError":
            return None

    request = event.get("request", {})
    headers = request.get("headers", {})

    for sensitive_header in ("Authorization", "Cookie", "X-Api-Key"):
        if sensitive_header in headers:
            headers[sensitive_header] = "[Filtered]"

    return event
```

Filtering should be narrow and documented. Do not hide real production failures simply to reduce alert volume.

---

## 9.2 FastAPI

Initialize with the same `sentry_sdk.init(...)` arguments as the Django example above (called once at process startup), then wire the app:

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/debug-sentry")
async def debug_sentry() -> None:
    raise RuntimeError("Sentry verification error")
```

Use a verification endpoint only temporarily in a controlled non-production environment, or protect it carefully. Remove it after validating the integration.

### Attach request context

```python
from fastapi import Request
import sentry_sdk

@app.middleware("http")
async def sentry_request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id", "unknown")

    with sentry_sdk.configure_scope() as scope:
        scope.set_tag("request_id", request_id)
        scope.set_tag("service", "payment-api")

    response = await call_next(request)
    response.headers["x-request-id"] = request_id
    return response
```

For concurrent applications, use the SDK's current isolation and scope APIs according to the installed SDK version. The central design principle is that request-specific context must not leak between concurrent requests.

---

## 9.3 Celery Workers

Celery errors occur outside the web request process, so worker initialization matters: call the same `sentry_sdk.init(...)` shown for Django, but from the worker application's own startup path (for a standalone deployment), not only from the web process.

Attach useful task context:

```python
from celery import shared_task
import sentry_sdk

@shared_task(
    bind=True,
    autoretry_for=(TimeoutError,),
    retry_backoff=True,
    max_retries=5,
)
def process_invoice(self, invoice_id: str) -> None:
    sentry_sdk.set_tag("task_name", self.name)
    sentry_sdk.set_context(
        "invoice",
        {
            "invoice_id": invoice_id,
            "retry_count": self.request.retries,
        },
    )

    # Processing logic...
```

Avoid sending complete message bodies when they may contain credentials or sensitive customer information.

---

## 9.4 Manual Error Capture

Unhandled exceptions are usually captured automatically by supported integrations.

Use manual capture when an exception is caught and not re-raised, a failure is represented by a returned error result, or you need to report a meaningful non-exception event.

### Capture an exception

```python
import sentry_sdk

try:
    charge_customer()
except PaymentProviderError as exc:
    sentry_sdk.capture_exception(exc)
    raise
```

### Capture a message

```python
sentry_sdk.capture_message(
    "Payment provider fallback activated",
    level="warning",
)
```

Do not send a Sentry event for every expected validation failure. Expected business errors should normally be represented through structured logs and metrics.

---

# 10. Correlation IDs and End-to-End Debugging

A correlation ID connects data across services and tools.

Without correlation:

```text
CloudWatch: Payment failed
Sentry: TimeoutError
Worker log: Retry started
```

With correlation:

```text
request_id=req-82c4
trace_id=2ac045d9ef3c4fc5
```

Now the same incident can be followed from the load balancer or gateway, through the API container, database operation, downstream service, queue message, and worker, to CloudWatch logs, the Sentry event, and the distributed trace.

### Request ID middleware example

```python
import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request

request_id_var: ContextVar[str] = ContextVar(
    "request_id",
    default="unknown",
)

app = FastAPI()

@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = request_id_var.set(request_id)

    try:
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        return response
    finally:
        request_id_var.reset(token)
```

### Propagation

Forward the request ID to downstream services:

```python
headers = {
    "x-request-id": request_id,
}
```

Include it in queue messages:

```json
{
  "event": "invoice.generate",
  "request_id": "req-82c4",
  "invoice_id": "inv-9102"
}
```

Add it to logs and Sentry tags.

### Trace IDs

When OpenTelemetry or another tracing system is used, prefer standard trace context propagation rather than creating an unrelated tracing format.

Request IDs remain useful for support and human communication, while trace IDs connect the formal distributed trace.

---

# 11. Monitoring the Four Golden Signals

A practical service dashboard should cover four essential signals.

## 11.1 Latency

How long does the operation take? Monitor P50, P95, P99, dependency latency, database latency, and queue processing time.

Do not rely only on average latency. Averages can hide a poor experience for a smaller but important percentage of users.

---

## 11.2 Traffic

How much demand is reaching the system? Monitor requests per second, jobs per minute, messages published, active users, concurrent connections, and data processed.

Traffic gives context to other signals. An error count of 100 has different meaning at:

```text
1,000 total requests  -> 10% error rate
1,000,000 requests    -> 0.01% error rate
```

---

## 11.3 Errors

How often is the system failing? Monitor HTTP 5xx rate, failed background tasks, unhandled exceptions, dependency failures, database errors, authentication failures, and business-operation failures.

Prefer rates for service-level alerts, for example `error_rate = failed_requests / total_requests`; absolute counts remain useful for low-traffic critical workflows.

---

## 11.4 Saturation

How close is the system to its limit? Monitor CPU, memory, disk, database connections, thread pools, queue depth, worker concurrency, rate-limit usage, and file descriptors.

Saturation often predicts an incident before customers see failures.

```mermaid
flowchart TD
    A[Queue depth rising] --> B[Worker capacity insufficient]
    B --> C[Processing delay increases]
    C --> D[Oldest message age breaches SLO]
```

---

# 12. Alert Design

A good alert is actionable, owned, prioritized, low-noise, linked to investigation context, tested, and based on customer or system impact.

### Alert severity

| Severity | Meaning | Example |
|---|---|---|
| Critical | Active major customer impact | Payment success rate below target |
| High | Significant degradation | API P95 above threshold with 5xx increase |
| Medium | Requires investigation during working hours | Queue backlog rising |
| Low | Informational or trend | Disk utilization approaching planning level |

A weak alert such as `CPU > 80% for 1 minute` may fire during normal short-lived bursts. A better alert combines conditions and stays closer to customer impact, for example `CPU > 85% for 15 minutes AND P95 latency > 1 second`.

### Multi-window thinking

Use short windows for fast detection and longer windows for confirmation — for example a fast signal at `error rate > 5% for 5 minutes` alongside a slower confirmation signal at `error rate > 1% for 30 minutes`.

### Alert content template

```text
Title: Payment API elevated failure rate

Environment: production
Region: ap-south-1
Service: payment-api
Observed: 6.4% failures
Threshold: 2% for 10 minutes
Started: 13:40 UTC
Release: 2026.07.30.2

Links:
- CloudWatch dashboard
- Logs Insights saved query
- Sentry issue or project
- Runbook
- Recent deployment
```

### Avoid duplicate alerts

Do not page separately for:

```text
High 5xx
High error logs
Many Sentry exceptions
High latency
```

when all four represent the same incident.

Use one primary paging signal and treat the others as diagnostic evidence.

### CloudWatch vs Sentry alert ownership

| Alert | Recommended Tool |
|---|---|
| ECS task count below minimum | CloudWatch |
| ALB 5xx rate high | CloudWatch |
| RDS storage low | CloudWatch |
| Queue age too high | CloudWatch |
| New unhandled application exception | Sentry |
| Previously resolved issue regressed | Sentry |
| Exception increased after release | Sentry |
| Application operation latency | CloudWatch, Sentry, or both depending on ownership |

---

# 13. Dashboards and Operational Views

Use separate dashboards for separate audiences.

## Service dashboard

For developers and on-call engineers: request rate, error rate, P50/P95/P99 latency, top slow endpoints, dependency latency, recent deployments, and active Sentry issues.

## Infrastructure dashboard

For platform and DevOps teams: ECS task CPU and memory, desired vs running tasks, ALB healthy targets, RDS CPU and connections, cache memory and evictions, queue depth, and disk utilization.

## Business-flow dashboard

For critical application outcomes: orders created, payments succeeded, payments failed, invoices generated, webhook processing delay, and lead creation success rate.

Business metrics are important because a technically healthy service can still fail to deliver the intended outcome — for example:

```text
HTTP 200 responses: Normal
CPU: Normal
Latency: Normal
Payment success: 0
```

Infrastructure-only monitoring may miss this failure.

---

# 14. Security and Sensitive Data

Logs and error events can unintentionally expose sensitive data.

Never log passwords, access tokens, refresh tokens, API keys, session cookies, authorization headers, private encryption keys, full payment-card data, unnecessary personal or medical information, or complete request bodies without review.

### Redaction

Redact known sensitive fields before telemetry leaves the application.

```python
SENSITIVE_KEYS = {
    "password",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "cookie",
    "api_key",
}

def redact(value):
    if isinstance(value, dict):
        return {
            key: "[Filtered]" if key.lower() in SENSITIVE_KEYS else redact(item)
            for key, item in value.items()
        }

    if isinstance(value, list):
        return [redact(item) for item in value]

    return value
```

### IAM least privilege

CloudWatch log writers should receive only the permissions they require. Separate permissions for writing logs, querying logs, changing retention, deleting log groups, creating alarms, and managing dashboards — an application should not need administrative CloudWatch permissions.

### Encryption and access

Review CloudWatch Logs encryption requirements, Sentry data-region and organizational policies, role-based access, audit requirements, retention and deletion policies, data-processing agreements, and tenant isolation.

Observability systems often contain production context and should be treated as sensitive systems.

---

# 15. Cost and Data-Volume Control

Observability cost is primarily influenced by data volume, retention, query patterns, metric cardinality, event sampling, and duplication.

## CloudWatch cost controls

- Set log retention explicitly.
- Avoid logging large request and response bodies.
- Disable production `DEBUG` logs by default.
- Use structured fields instead of repeated multiline text.
- Query narrow time windows.
- Avoid unnecessary high-resolution custom metrics.
- Avoid high-cardinality metric dimensions.
- Filter logs before ingestion when appropriate.
- Archive only data that has a real retention requirement.
- Review unused dashboards and alarms.
- Use one meaningful metric rather than several duplicate metrics.

## Sentry cost controls

- Configure trace sampling.
- Drop known non-actionable events.
- Separate environments.
- Avoid capturing expected validation errors.
- Review noisy issue sources.
- Add rate and volume controls.
- Avoid attaching large payloads.
- Use targeted Session Replay or profiling where relevant rather than enabling maximum capture everywhere.
- Review alert rules that cause repeated notifications.

### Sampling principle

Sample high-volume performance data, but preserve enough data to investigate important operations.

Example strategy:

| Transaction | Suggested Starting Approach |
|---|---|
| Health checks | Do not trace |
| Static endpoints | Very low sampling |
| Standard API traffic | Moderate sampling |
| Payments or claims | Higher sampling |
| Errors | Capture with appropriate controls |
| Background batch jobs | Sample based on volume and criticality |

Sampling values must be tested against real traffic and budget.

---

# 16. Deployment Checklist

## Application logging

- [ ] Logs go to `stdout` and `stderr`.
- [ ] Production logs are structured JSON.
- [ ] Every log has service and environment fields.
- [ ] Important request logs include `request_id`.
- [ ] Trace IDs are included when tracing is enabled.
- [ ] Log level is configurable.
- [ ] Secrets and sensitive fields are redacted.
- [ ] Stack traces are recorded for unexpected failures.
- [ ] Stable event names are used.

## CloudWatch

- [ ] Log groups are created through infrastructure as code.
- [ ] Retention is configured.
- [ ] IAM permissions follow least privilege.
- [ ] Container logs reach CloudWatch.
- [ ] CPU, memory, disk, and dependency metrics are available.
- [ ] Critical service alarms are configured.
- [ ] Alarm notifications reach the correct owner.
- [ ] Dashboard links are included in incident alerts.
- [ ] Saved Logs Insights queries exist for common investigations.
- [ ] Billing and telemetry volume are reviewed.

## Sentry

- [ ] DSN is injected securely.
- [ ] Correct environment is configured.
- [ ] Release identifier is configured.
- [ ] Source integration or source mapping is configured where relevant.
- [ ] Sensitive data is filtered.
- [ ] Trace sampling is explicitly configured.
- [ ] New issue and regression alerts are configured.
- [ ] Team ownership is configured.
- [ ] Test exceptions have been verified.
- [ ] Non-actionable events are filtered carefully.

## Incident readiness

- [ ] Each critical alert has a runbook.
- [ ] Alert severity is defined.
- [ ] On-call ownership is clear.
- [ ] Recent deployment information is available.
- [ ] Request and trace correlation works.
- [ ] Alerts have been tested.
- [ ] Recovery conditions are defined.

---

# 17. Practical Incident Walkthrough

Consider a production payment API running as ECS containers.

## Symptom

Customers report checkout failures.

## Step 1: Check the service dashboard

CloudWatch shows:

```text
Request rate: Normal
P95 latency: Increased from 300 ms to 4.2 s
Target 5xx rate: Increased to 7%
ECS CPU: 42%
ECS memory: 55%
RDS connections: Normal
```

Interpretation:

The infrastructure is not saturated. The problem is likely inside the application or a dependency.

## Step 2: Check Sentry

Sentry shows:

```text
Issue: TimeoutError in payment_provider.py
First seen: 4 minutes after release 2026.07.30.2
Events: 1,482
Provider: stripe
Endpoint: POST /payments
```

Interpretation:

A release correlation exists, but it is not yet proof that the deployment caused the failure.

## Step 3: Inspect a trace

```text
POST /payments                           4.4 s
├── Validate request                       5 ms
├── Database lookup                       32 ms
├── Payment provider call              4,300 ms
└── Error handling                        18 ms
```

Interpretation:

The external provider call dominates the latency.

## Step 4: Search CloudWatch logs

```sql
fields @timestamp, request_id, provider, duration_ms, message
| filter event = "payment_provider_failed"
| sort @timestamp desc
| limit 100
```

Logs show:

```text
provider=stripe
duration_ms=4300
retry_count=2
error_type=TimeoutError
```

## Step 5: Correlate one request

Using `request_id=req-82c4`:

```text
API accepted request
Payment attempt started
Provider timed out
Retry started
Provider timed out
Fallback was not activated
HTTP 500 returned
```

## Step 6: Mitigate

Possible mitigation:

- Enable a safe fallback
- Increase capacity only if the bottleneck is internal
- Roll back the release if timeout handling changed
- Temporarily adjust retry behavior
- Use a circuit breaker to prevent cascading failures
- Contact the dependency provider when external degradation is confirmed

## Step 7: Improve after resolution

- Add a dependency latency alarm.
- Add a payment success-rate business alarm.
- Add a circuit-breaker state metric.
- Improve timeout and retry logs.
- Add the runbook link to the alert.
- Verify that the same failure does not create duplicate pages from several systems.

This flow demonstrates the complementary roles:

```text
CloudWatch detected service degradation.
Sentry identified the failing code path.
Tracing identified the slow dependency.
Structured logs reconstructed the request timeline.
```

---

# 18. Official References

## AWS

- [What is Amazon CloudWatch?](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html)
- [Metrics in Amazon CloudWatch](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/working_with_metrics.html)
- [What is Amazon CloudWatch Logs?](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html)
- [CloudWatch Logs Insights query syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)
- [Using Amazon CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html)
- [Using Amazon CloudWatch dashboards](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [Collect metrics, logs, and traces using the CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html)
- [CloudWatch Application Signals](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Monitoring-Sections.html)
- [Send Amazon ECS logs to CloudWatch](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html)

## Docker

- [Configure Docker logging drivers](https://docs.docker.com/engine/logging/configure/)
- [Amazon CloudWatch Logs logging driver](https://docs.docker.com/engine/logging/drivers/awslogs/)
- [Docker JSON file logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)

## Sentry

- [Sentry documentation](https://docs.sentry.io/)
- [Sentry for Python](https://docs.sentry.io/platforms/python/)
- [Sentry FastAPI integration](https://docs.sentry.io/platforms/python/integrations/fastapi/)
- [Sentry Celery integration](https://docs.sentry.io/platforms/python/integrations/celery/)
- [Sentry Python SDK options](https://docs.sentry.io/platforms/python/configuration/options/)

---

> **Revision note:** Cloud observability products evolve frequently. Verify SDK-specific options and AWS service support against the official documentation before production rollout.
