---
title: "Celery Beat"
group: "Scheduling & Frameworks"
order: 5
---

# Periodic / Scheduled Tasks (Celery Beat)

> Beat is one scheduler process that publishes a task message to the broker on a cron, interval, or solar schedule. It never runs the task itself, that is a worker's job.

## What it is
**Beat is a clock, not a runner.** On each tick it checks which entries are due and drops exactly one message on the broker per due entry. The pipeline runs one way: **Beat** (exactly one process) publishes on schedule -> **broker** holds the message -> **worker(s)** pull it and execute.

Beat and the worker are separate processes with separate lifecycles, and that split is the point. You scale workers freely while exactly one beat keeps time.

> [!KEY] Beat only decides *when* and publishes a message. The **worker** decides nothing about timing and does the actual work. With no worker running, beat still looks healthy while messages just queue.

## Key points
- Configure `app.conf.beat_schedule`, a dict of named entries. Each entry needs a `task` (the registered task name, not its import path) and a `schedule`. `args`, `kwargs`, and `options` (routing, `expires`) are optional.
- Three schedule types cover almost everything, each set on an entry's `schedule` key:

| Schedule | Set with | Fires |
| --- | --- | --- |
| **Interval** | a number of seconds or `timedelta(...)` | every N seconds, **first run one full interval after beat boots**, not immediately |
| **Crontab** | `crontab(minute, hour, day_of_week, day_of_month, month_of_year)` | at **calendar times**, read in your configured timezone |
| **Solar** | `solar(event, lat, lon)`, e.g. `'sunset'` | at a **sun event**, always computed in **UTC** regardless of `timezone` |

- `crontab` fields each take cron expressions like `'*/15'` or `'3,17,22'`. The timezone defaults to UTC, so set `app.conf.timezone = 'Asia/Kolkata'` if you want 2am to mean 2am locally. Solar ignores that setting and stays UTC.
- Which scheduler you run decides where the schedule lives and whether you can edit it live:

| Scheduler | Schedule stored in | Edit at runtime? | Reach for it when |
| --- | --- | --- | --- |
| `PersistentScheduler` (default) | a local **`celerybeat-schedule`** shelve file (move with `-s`) | **No** - redeploy to change `beat_schedule` | simple single-beat setups |
| `DatabaseScheduler` (`django-celery-beat`) | **Django DB models** (`PeriodicTask`, `CrontabSchedule`, `IntervalSchedule`, ...) | **Yes, from the admin**, applied on beat's next tick | ops must change schedules without a deploy |
| `RedBeatScheduler` (`celery-redbeat`) | **Redis**, behind a **TTL lock** | Yes, via Redis | **HA** - run several beats, only the lock holder ticks |

- Run beat as its own process: `celery -A app beat`, adding `-S django` to select DatabaseScheduler. Beat persists last-run state (the shelve file, or the DB/Redis) so a restart does not refire everything at once.
- On an async stack (FastAPI and friends) Celery's process model feels heavy. **Taskiq** is the async-native equivalent with the same shape: a separate `TaskiqScheduler(broker, sources=[LabelScheduleSource(broker)])`, cron or interval declared per task, and the identical "run only one scheduler" rule.

> [!TIP] The `task` value is the **registered name** Celery stored (the dotted path by default), not a function you import and call. Beat publishes that string and the worker resolves it, so a typo fails on the worker at run time, not at beat startup.

## Example
```python
from celery.schedules import crontab, solar

app.conf.timezone = "Asia/Kolkata"           # crontab times are read in this zone

app.conf.beat_schedule = {
    "nightly-report": {
        "task": "reports.generate",              # registered task name, not import path
        "schedule": crontab(hour=2, minute=0),   # 02:00 local, every day
    },
    "heartbeat": {
        "task": "ops.ping",
        "schedule": 30.0,                        # every 30s; first run 30s after boot
    },
    "close-the-blinds": {
        "task": "home.blinds_down",
        "schedule": solar("sunset", 19.07, 72.87),   # lat/lon; computed in UTC
    },
}
```
```bash
celery -A app beat -l info             # good: exactly ONE beat process keeps time
celery -A app worker -l info           # workers run separately and do the work

celery -A app beat -l info -S django   # runtime-editable schedules (django-celery-beat)

celery -A app worker -B -l info        # avoid: -B embeds beat in the worker (dev only)
```

## Interview Q&A
- **What does Beat actually do?** It publishes one message to the broker per due entry and nothing more. Whichever worker pulls that message runs the task. With no worker up, the messages just sit in the queue.
- **How do you define schedules?** `beat_schedule` entries keyed by name, each with a `task` and a `schedule` that is a number or `timedelta` (interval), `crontab(...)`, or `solar(...)`.
- **Why only one Beat?** Every running scheduler ticks independently and publishes what it thinks is due, so two beats fire each task twice. Pin it to one instance, or use a locking scheduler like RedBeat for failover.
- **How do you change a schedule without redeploying?** `django-celery-beat`'s `DatabaseScheduler` holds entries in the DB, editable from the admin. Beat reloads them on its next tick.
- **If beat is down at 2am, does the job run late?** No. There is no backfill and a missed window is skipped. If the run matters, build catch-up logic or a query that processes everything since the last success.

## Gotchas
> [!WARN] Run **exactly one** beat process. Each scheduler independently decides an entry is due and publishes it, so **two beats fire every periodic task twice** (N schedulers -> N copies). The classic trap is an embedded `-B` beat in a worker you later scale to three pods. Pin beat to one replica (a single-replica Deployment in Kubernetes), or use RedBeat's lock for HA.

> [!WARN] Beat does **not** check whether the previous run finished, and it **never backfills**. A 10-minute task on a 5-minute schedule overlaps and stacks up, so add your own lock (Redis `SETNX`, a DB row) when a task must not run concurrently. Beat down across a window simply skips those runs.

- A beat with no worker looks healthy while doing nothing useful: it publishes on schedule, but messages pile up until something drains the queue.
- DatabaseScheduler edits apply on beat's next tick, not instantly. After a bulk update made outside the admin, call `PeriodicTasks.changed()` to force a reload.

## Revise next
- [Celery worker and broker architecture](celery-architecture.md) (Redis vs RabbitMQ vs SQS delivery)
- [Idempotency](idempotency-background-tasks.md) and locking for overlapping runs
- django-celery-beat vs RedBeat (runtime edits vs HA locking)
- [Taskiq scheduler](celery-vs-taskiq.md) (async-native alternative)

*Reviewed against Celery 5.6, July 2026.*
