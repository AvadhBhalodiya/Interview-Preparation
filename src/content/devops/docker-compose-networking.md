---
title: "Compose & Networking"
group: "Docker"
order: 2
updated: "30 July 2026 against the current Docker Compose Specification and official Docker/AWS documentation"
---

# Docker Volumes, Networking & Compose

> Practical interview notes for understanding how multi-container applications store data, communicate, and run together.

## Index

1. [Core Mental Model](#1-core-mental-model)
2. [Docker Storage and Volumes](#2-docker-storage-and-volumes)
   - Container writable layer
   - Named volumes
   - Bind mounts
   - `tmpfs`
3. [Docker Networking](#3-docker-networking)
   - Bridge networks
   - DNS and service names
   - `localhost`
   - `ports`, `expose`, and `EXPOSE`
   - Network isolation
4. [Docker Compose](#4-docker-compose)
   - Services, networks, and volumes
   - `depends_on` and health checks
   - Environment variables and secrets
5. [Complete Practical Example](#5-complete-practical-example)
6. [Daily Commands and Troubleshooting](#6-daily-commands-and-troubleshooting)
7. [Production Best Practices](#7-production-best-practices)

---

# 1. Core Mental Model

A real backend application commonly has multiple components:

- API service
- PostgreSQL database
- Redis cache
- Background worker
- Reverse proxy

Running each container manually becomes difficult because we must manage:

- startup commands
- environment variables
- networking
- persistent data
- dependencies
- health checks

Docker solves these concerns with three related concepts:

| Concept | Responsibility |
|---|---|
| **Volume** | Keeps important data outside a container's temporary writable layer |
| **Network** | Allows containers to communicate with each other |
| **Docker Compose** | Defines and runs the complete multi-container application |

```mermaid
flowchart LR
    U[Client] -->|localhost:8000| A[FastAPI]
    A -->|db:5432| D[(PostgreSQL)]
    A -->|redis:6379| R[(Redis)]
    D --- V[(Named Volume)]
```

The most useful mental model is:

> **Containers are replaceable. Persistent state lives outside them, services communicate by name, and Compose describes how the complete application fits together.**

---

# 2. Docker Storage and Volumes

## 2.1 Container Writable Layer

A Docker image is read-only.

When Docker starts a container, it adds a writable layer on top of the image. Files created inside the container normally go into this layer.

```mermaid
flowchart TB
    W[Container Writable Layer<br/>Temporary runtime changes]
    A[Application Image Layer]
    D[Dependency Layer]
    B[Base Image]

    W --> A --> D --> B
```

If the container is removed, its writable layer is removed too.

Example:

```bash
docker run --name demo alpine sh -c \
  'echo "hello" > /data.txt && sleep 300'

docker rm -f demo
```

A new container created from the same image will not contain `/data.txt`.

### Why this matters

A database should not keep its real data only inside the container writable layer.

Use persistent storage for state that must survive container replacement.

---

## 2.2 Storage Options

The three storage options you should know are:

| Storage | Managed by | Best use | Survives container removal |
|---|---|---|---:|
| **Named volume** | Docker | Databases and persistent application data | Yes |
| **Bind mount** | Host/developer | Source code and local configuration | Yes |
| **`tmpfs`** | Memory | Temporary runtime data | No |

---

## 2.3 Named Volumes

A named volume is persistent storage managed by Docker.

```bash
docker volume create postgres_data

docker run -d \
  --name postgres \
  --mount type=volume,source=postgres_data,target=/var/lib/postgresql/data \
  postgres:18
```

The important point is that the volume has a lifecycle independent of the container.

```mermaid
sequenceDiagram
    participant C1 as PostgreSQL v1
    participant V as postgres_data
    participant C2 as PostgreSQL v2

    C1->>V: Write database files
    Note over V: Container v1 removed
    C2->>V: Mount same volume
    V-->>C2: Existing database files
```

Use named volumes for:

- PostgreSQL/MySQL data
- Redis persistence when required
- application-generated persistent files

Common commands:

```bash
docker volume ls
docker volume inspect postgres_data
docker volume rm postgres_data
docker volume prune
```

> `docker volume prune` removes unused volumes. Review carefully before running it.

---

## 2.4 Bind Mounts

A bind mount maps a host path directly into a container.

```bash
docker run --rm \
  --mount type=bind,source="$(pwd)/app",target=/app \
  python:3.13-slim \
  python /app/main.py
```

Typical use:

- edit source code on the host and immediately use it inside the container
- mount local configuration
- share files with host-side development tools

Compose example:

```yaml
services:
  api:
    volumes:
      - ./app:/app/app
```

A bind mount is convenient in development but creates stronger coupling to the host filesystem.

For production application code, prefer building code into an immutable image instead of mounting the source directory from the host.

---

## 2.5 `tmpfs`

A `tmpfs` mount stores temporary data in memory rather than persistent storage.

```yaml
services:
  api:
    tmpfs:
      - /tmp
```

Useful for:

- temporary files
- short-lived runtime data
- caches that should disappear when the container stops

Do not use it for persistent application data.

---

## 2.6 Read-Only Mounts

If a container only needs to read a file, mount it read-only.

```yaml
services:
  nginx:
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
```

This prevents accidental modification from inside the container.

---

## 2.7 Important Volume Lifecycle Rule

```bash
docker compose down
```

removes project containers and networks, but normally keeps named volumes.

```bash
docker compose down --volumes
```

also deletes Compose-managed named volumes.

For a database container, that can mean deleting the stored database data.

---

# 3. Docker Networking

## 3.1 Bridge Networks

For normal single-host applications, the most common Docker network type is a **bridge network**.

A user-defined bridge network provides:

- container-to-container communication
- automatic DNS resolution by container/service name
- isolation from unrelated containers

Example without Compose:

```bash
docker network create app_network

docker run -d \
  --name redis \
  --network app_network \
  redis:8-alpine
```

Another container on `app_network` can connect to hostname `redis`.

---

## 3.2 Compose Creates Service Discovery Automatically

Docker Compose normally creates a project network automatically.

Services attached to the same Compose network can reach one another using the **service name as the hostname**.

```yaml
services:
  api:
    environment:
      DATABASE_HOST: db
      REDIS_HOST: redis

  db:
    image: postgres:18

  redis:
    image: redis:8-alpine
```

The API should connect to:

```text
db:5432
redis:6379
```

Do not hardcode container IP addresses. A container can receive a different IP after recreation.

```mermaid
flowchart LR
    A[API] -->|DNS: db| DNS[Docker Embedded DNS]
    DNS -->|Current container IP| A
    A -->|TCP 5432| D[(PostgreSQL)]
```

---

## 3.3 The `localhost` Rule

Inside a container:

> **`localhost` means the current container itself.**

Suppose FastAPI and PostgreSQL run in separate containers.

Wrong:

```text
postgresql://app:secret@localhost:5432/appdb
```

FastAPI will look for PostgreSQL inside the FastAPI container.

Correct:

```text
postgresql://app:secret@db:5432/appdb
```

where `db` is the Compose service name.

This is one of the most common Docker networking concepts discussed in interviews and debugging.

---

## 3.4 `ports`, `expose`, and Dockerfile `EXPOSE`

These are related but different.

### `ports`

Publishes a container port to the host.

```yaml
services:
  api:
    ports:
      - "8000:8000"
```

Format:

```text
HOST_PORT:CONTAINER_PORT
```

Traffic flow:

```mermaid
flowchart LR
    B[Browser] -->|localhost:8000| H[Host Port 8000]
    H --> A[API Container Port 8000]
```

To make a service reachable only from the local machine:

```yaml
ports:
  - "127.0.0.1:8000:8000"
```

### `expose`

```yaml
expose:
  - "8000"
```

`expose` documents the container port for inter-service use but does **not** publish it to the host.

Containers on the same Docker network can normally communicate with the target container port even when `expose` is omitted.

### Dockerfile `EXPOSE`

```dockerfile
EXPOSE 8000
```

This is image metadata describing the intended listening port.

It does not publish the port to the host.

### Practical comparison

| Configuration | Other containers on same network | Host machine |
|---|---:|---:|
| App listens on container port | Yes | No |
| `expose: ["8000"]` | Yes | No |
| `ports: ["8000:8000"]` | Yes | Yes |
| Dockerfile `EXPOSE 8000` only | Yes, if app listens | No |

---

## 3.5 Connecting from a Container to the Host

On Docker Desktop, a container can normally reach a host-side service using:

```text
host.docker.internal
```

Example:

```text
http://host.docker.internal:9000
```

This is for reaching the **host**, not another Compose service.

For Compose service-to-service communication, use service names.

---

## 3.6 Network Isolation

Services do not all need to share the same network.

A common architecture is:

```mermaid
flowchart LR
    U[Client] --> A[API]

    subgraph app_network
        A
    end

    subgraph data_network
        A2[API]
        D[(PostgreSQL)]
        R[(Redis)]
    end
```

Example:

```yaml
services:
  api:
    networks:
      - app_network
      - data_network

  db:
    networks:
      - data_network

  redis:
    networks:
      - data_network

networks:
  app_network:
  data_network:
    internal: true
```

Only services that need database/cache access should join the data network.

---

# 4. Docker Compose

Docker Compose defines a multi-container application using YAML.

Modern Docker uses:

```bash
docker compose
```

The older standalone command:

```bash
docker-compose
```

is legacy.

Modern Compose uses the rolling **Compose Specification**. A top-level `version:` field is obsolete and is no longer required.

---

## 4.1 Main Compose Objects

A Compose application commonly defines:

- **services** — containers that make up the application
- **networks** — communication boundaries
- **volumes** — persistent storage
- **configs** — non-sensitive configuration
- **secrets** — sensitive values/files supported by the runtime

Minimal example:

```yaml
name: sample-app

services:
  api:
    build: .
    ports:
      - "8000:8000"
    networks:
      - backend

  db:
    image: postgres:18
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend

networks:
  backend:

volumes:
  postgres_data:
```

---

## 4.2 Common Service Configuration

```yaml
services:
  api:
    build: .
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000

    environment:
      APP_ENV: development

    env_file:
      - .env

    ports:
      - "8000:8000"

    volumes:
      - ./app:/app/app

    restart: unless-stopped
```

Important fields:

| Field | Purpose |
|---|---|
| `image` | Use an existing image |
| `build` | Build an image from local source |
| `command` | Override the image's default command |
| `environment` | Set container environment variables |
| `env_file` | Load environment variables from a file |
| `ports` | Publish ports to the host |
| `volumes` | Mount volumes or host paths |
| `networks` | Attach service to networks |
| `depends_on` | Express service startup dependencies |
| `healthcheck` | Define container health |
| `restart` | Configure restart behavior |

---

## 4.3 `depends_on` Is Not the Same as Readiness

Basic dependency:

```yaml
services:
  api:
    depends_on:
      - db
```

This controls startup order, but a started database process may still need time before it can accept connections.

Use a health check:

```yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:18

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
```

```mermaid
stateDiagram-v2
    [*] --> Starting
    Starting --> Healthy: health check succeeds
    Starting --> Unhealthy: retry limit reached
    Healthy --> Unhealthy: checks fail
    Unhealthy --> Healthy: check succeeds
```

Even with `service_healthy`, the application should implement bounded connection retries because dependencies may fail or restart later.

---

## 4.4 `.env`, `environment`, and `env_file`

These are easy to confuse.

`.env` can provide values used while Compose interpolates the YAML:

```dotenv
APP_PORT=8000
```

```yaml
services:
  api:
    ports:
      - "${APP_PORT:-8000}:8000"
```

`environment` puts values into the container:

```yaml
environment:
  APP_ENV: development
```

`env_file` also loads variables into the container:

```yaml
env_file:
  - .env
```

Do not treat a committed `.env` file as secure production secret storage.

For production, use the secret-management mechanism provided by the deployment platform, such as AWS Secrets Manager or Systems Manager Parameter Store.

---

# 5. Complete Practical Example

This single example combines the important concepts:

- FastAPI application
- PostgreSQL database
- Redis cache
- named database volume
- service-name DNS
- health checks
- network isolation
- one host-published API port

## 5.1 Architecture

```mermaid
flowchart LR
    C[Client] -->|localhost:8000| A[FastAPI]

    A -->|db:5432| D[(PostgreSQL)]
    A -->|redis:6379| R[(Redis)]

    D --- V[(postgres_data)]

    subgraph public network
        A
    end

    subgraph backend network
        A2[FastAPI]
        D
        R
    end
```

## 5.2 `compose.yaml`

```yaml
name: interview-demo

services:
  api:
    build: .
    ports:
      - "127.0.0.1:8000:8000"

    environment:
      DATABASE_URL: postgresql://app:localpassword@db:5432/appdb
      REDIS_URL: redis://redis:6379/0

    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy

    healthcheck:
      test:
        [
          "CMD",
          "python",
          "-c",
          "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')",
        ]
      interval: 10s
      timeout: 3s
      retries: 5

    networks:
      - public
      - backend

  db:
    image: postgres:18

    environment:
      POSTGRES_DB: appdb
      POSTGRES_USER: app
      POSTGRES_PASSWORD: localpassword

    volumes:
      - postgres_data:/var/lib/postgresql/data

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10

    networks:
      - backend

  redis:
    image: redis:8-alpine

    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

    networks:
      - backend

networks:
  public:
  backend:
    internal: true

volumes:
  postgres_data:
```

## 5.3 How Communication Works

From the API container:

```text
PostgreSQL -> db:5432
Redis      -> redis:6379
```

From the host:

```text
FastAPI -> localhost:8000
```

The database and Redis are not published to the host.

Their ports remain available to the API through the shared `backend` network.

## 5.4 Run It

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f
```

Stop containers while keeping database data:

```bash
docker compose down
```

Delete containers **and** the database volume:

```bash
docker compose down --volumes
```

---

# 6. Daily Commands and Troubleshooting

## 6.1 Most-Used Compose Commands

```bash
docker compose up -d
docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose logs -f api
docker compose exec api sh
docker compose restart api
docker compose stop
docker compose down
docker compose config
```

### `exec` vs `run`

Use `exec` to run a command inside an already-running service container:

```bash
docker compose exec api sh
```

Use `run` to create a new one-off container from a service definition:

```bash
docker compose run --rm api python -m pytest
```

---

## 6.2 Service Cannot Reach Another Service

Start with:

```bash
docker compose ps
docker compose logs --tail=100 api
docker compose exec api getent hosts db
```

Check these four things:

1. Both services share a network.
2. The client uses the service name, such as `db`, not `localhost`.
3. The destination process is listening on the expected container port.
4. The destination service is healthy.

For TCP connectivity:

```bash
docker compose exec api python -c \
  "import socket; socket.create_connection(('db', 5432), timeout=3); print('connected')"
```

---

## 6.3 Published Port Does Not Work

```bash
docker compose ps
docker compose port api 8000
```

Check:

- correct host/container port mapping
- another host process is not already using the port
- application listens on `0.0.0.0` inside the container
- firewall/security rules when running on a remote server

An application listening only on container `127.0.0.1` is usually not reachable through Docker port publishing.

---

## 6.4 Data Disappeared

Check:

```bash
docker compose config
docker volume ls
docker volume inspect interview-demo_postgres_data
```

Typical causes:

- application wrote to the wrong path
- a different Compose project name created a different volume
- `docker compose down --volumes` was run
- expected named volume was not mounted

---

## 6.5 Compose Uses Unexpected Values

Render the final configuration:

```bash
docker compose config
docker compose config --environment
```

This is one of the best debugging commands because it shows the resolved Compose model after interpolation and file merging.

---

# 7. Production Best Practices

## 7.1 Keep Containers Replaceable

Do not manually modify running containers and depend on those changes.

Rebuild from an image and keep persistent state externally.

```text
Replaceable container + externalized state = safer deployment
```

---

## 7.2 Keep Application Services Stateless

API containers should normally be replaceable and horizontally scalable.

Persistent state belongs in systems such as:

- PostgreSQL/MySQL
- Redis when persistence is required
- object storage
- queue/broker
- persistent filesystem when genuinely necessary

Avoid storing important user state only on one API container's local filesystem.

---

## 7.3 Publish Only Required Ports

A database does not need a host port just because the API needs to reach it.

Preferred pattern:

```text
Internet/Host -> API
API           -> Database
API           -> Redis
```

Only the API/reverse proxy is normally published.

---

## 7.4 Use Service Names, Not IP Addresses

Correct:

```text
postgresql://db:5432/appdb
```

Fragile:

```text
postgresql://172.20.0.4:5432/appdb
```

Container IPs are runtime details and may change.

---

## 7.5 Use Health Checks and Application Retries

Health checks help Compose understand service health.

Retries help the application survive temporary dependency failures after startup.

Use bounded retries with backoff rather than an infinite tight retry loop.

---

## 7.6 Run as Non-Root

Production images should normally run the application as a non-root user.

Example:

```dockerfile
RUN addgroup --system app \
    && adduser --system --ingroup app app

USER app
```

Also ensure mounted files are readable/writable by that UID/GID when needed.

---

## 7.7 Pin Image Versions

Prefer controlled image versions:

```yaml
image: postgres:18
```

instead of:

```yaml
image: postgres:latest
```

For high reproducibility, production pipelines may pin an image digest as well.

---

## 7.8 Keep Secrets Out of Images and Git

Do not commit real secrets in:

- Dockerfiles
- Compose files
- `.env` files
- source code

Use runtime secret management appropriate to the deployment platform.

---

## 7.9 Volumes Are Not Backups

A named volume survives container replacement, but it can still be lost through:

- host failure
- accidental deletion
- corruption
- application errors

For PostgreSQL, use database-aware backups such as `pg_dump`/`pg_restore`, plus tested recovery procedures.

---

# Final Interview Summary

For a normal multi-container backend:

```text
FastAPI -> service name "db" -> PostgreSQL
        -> service name "redis" -> Redis
```

Remember these points:

- The container writable layer disappears when the container is removed.
- Use **named volumes** for persistent container data.
- Use **bind mounts** mainly for development source/configuration.
- On a Compose network, containers reach each other by **service name**.
- `localhost` inside a container means **that container itself**.
- `ports` publishes to the host; `expose` does not.
- Compose automatically gives services a project network unless you define networks explicitly.
- `depends_on` controls dependency order; `service_healthy` adds readiness coordination.
- Applications should still retry failed dependency connections.
- `docker compose down` keeps named volumes; `down --volumes` removes them.
- Modern Compose follows the rolling **Compose Specification**; the top-level `version:` field is obsolete.
