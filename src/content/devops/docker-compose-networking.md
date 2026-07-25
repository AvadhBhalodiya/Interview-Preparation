---
title: "Compose & Networking"
group: "Docker"
order: 2
---

# Docker Volumes, Networking & Compose

> Compose describes a multi-container app in one `compose.yaml` and brings it up with `docker compose up`. Every service lands on one per-project network where it's reachable by service name, and volumes keep data alive after a container is thrown away.

## What it is
- Compose turns a whole app (API server, background worker, database, cache) into one declarative `compose.yaml` you start with `docker compose up` and tear down with `docker compose down`. One file, one command, the same topology on every machine.
- Under the hood it fixes the two things a lone container can't do for itself: let peers find each other, and keep its data once the container is replaced.

> [!KEY] Compose hands each container the two things it can't give itself: a **shared per-project network** so services reach each other by name, and **volumes** so state outlives the container.

One `docker compose up` builds the whole topology. Here is the model it wires:

| Piece | What Compose sets up |
| --- | --- |
| Default network | **One per-project bridge**, named `<project>_default`, with every service attached |
| Service discovery | Reach a peer by its **service name** through Docker's embedded DNS at `127.0.0.11` - `web` dials `db:5432`, no IPs, no `--link` |
| `ports` | Publishes a container port **to the host** (`"8000:8000"`) - the only reason to add it |
| `expose` | **Documents** an internal port and publishes nothing - largely redundant, since peers already reach any container port on the shared network |
| `depends_on` | Orders **startup only**, not readiness - pair it with a `healthcheck` to wait for the app inside |

## Key points
- **Use `docker compose` (V2), not `docker-compose` (V1).** V1 was the Python tool from 2014. V2 is a Go plugin built into the Docker CLI and the only version still maintained. If a tutorial writes `docker-compose` with a hyphen, it's stale.
- The Compose Specification merged the old `version: "3.x"` file-format numbers into one spec, so drop the top-level `version:` key. V2 treats it as obsolete and warns.
- Service-to-service traffic uses the **container port**, never a published one. `ports:` exists only to reach a service **from the host**, so your `db` needs no `ports:` entry for `web` to talk to it.
- A container's writable layer is ephemeral and dies with the container, so anything stateful needs storage mounted outside it.

Two ways to persist data outside that throwaway layer:

|  | **Named volume** | **Bind mount** |
| --- | --- | --- |
| Mount syntax | `db-data:/var/lib/postgresql/data` | `./src:/app/src` |
| Backing store | **Docker-managed** area on the host | A **specific host path** you pick |
| Best for | **Databases** and stateful services | **Live-reloading source** in dev |
| Lifecycle | Survives `down`, wiped only by `down -v` | Tied to the **host directory**, not Docker |

`depends_on` accepts one of three conditions, and only one of them means "ready":

| Condition | The dependent service waits until… |
| --- | --- |
| `service_started` (**default**) | the dependency's **container starts** - process up, app maybe not listening yet |
| `service_healthy` | the dependency's **`healthcheck` passes** - the app actually accepts connections |
| `service_completed_successfully` | the dependency **exits 0** - for one-shot init or migration jobs |

> [!TIP] Rule of thumb for `ports`: add it only for traffic you `curl` or open in a browser **from the host**. For service-to-service calls leave `ports` off, since the shared network already connects them.

## Example
```yaml
services:
  web:
    build: .
    ports: ["8000:8000"]                 # only needed to reach web from the host
    environment:
      DATABASE_URL: postgres://app:pw@db:5432/app   # "db" resolves by service name
    depends_on:
      db:
        condition: service_healthy       # wait until Postgres actually accepts connections
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: pw
      POSTGRES_DB: app
    volumes: ["db-data:/var/lib/postgresql/data"]   # persist data across recreation
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 5
    # no ports: on db - web reaches it over the internal network, the host doesn't need it

volumes:
  db-data:
```

## Interview Q&A
- **What does Compose actually do for you?** It describes a multi-container app in one `compose.yaml` and runs it as a unit, wiring the network and volumes so services discover each other and data persists.
- **How do two services talk?** Over the per-project bridge network Compose creates, addressing each other by service name via Docker's DNS (`db:5432`). No IPs, no `--link`.
- **`ports` vs `expose`?** `ports` publishes a container port to the host. `expose` only documents an internal port and publishes nothing, so on a shared Compose network it is effectively a no-op for connectivity.
- **Named volume vs bind mount?** A named volume is Docker-managed storage you'd use for a database. A bind mount maps a specific host directory into the container, which is what you want for editing source live in dev.
- **Does `depends_on` mean the database is ready?** No, only that its container started. For real readiness you need a healthcheck plus `condition: service_healthy`.

## Gotchas
> [!WARN] **`depends_on` is start order, not readiness.** A bare `depends_on: [db]` lets `web` race a Postgres that hasn't opened its socket yet. Add a `healthcheck` on `db` and `condition: service_healthy` on `web` to actually wait.

> [!WARN] **Publishing a port and reaching a service are different things.** `web` reaches `db` with no `ports:` at all, because service-to-service traffic uses the container port on the internal network. Publishing `5432` won't help the app connect, it only exposes your database on the host.

- A DB service with no volume looks fine right up until the first `docker compose down` quietly wipes it. Mount a named volume for anything stateful.
- `docker-compose` (hyphen, V1) is unmaintained, so use `docker compose`. Old copy-pasted V1 files are the usual trip-up, along with a leftover top-level `version:` key that V2 now flags as obsolete.
- Name resolution by service name only works on Compose's per-project bridge, a user-defined network. Plain `docker run` on Docker's default bridge can't resolve names at all, leaving you with IPs or the legacy `--link`.

## Revise next
- [Docker images and multi-stage builds](docker-images-builds.md)
- [AWS ECS on Fargate](aws-core-services.md) (production orchestration)
- Running Postgres in containers: volumes, backups, migrations

*Reviewed against Docker Engine 29 / Compose v2, July 2026.*
