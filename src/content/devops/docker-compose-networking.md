---
title: "Compose & Networking"
group: "Docker"
order: 2
updated: "30 July 2026 against the current Docker Compose Specification and official Docker/AWS documentation"
---

# Docker Volumes, Networking & Compose

> Practical understanding for development, deployment, debugging, and technical interviews

## In short

- **Container writable layer** is deleted with the container — anything written there (for example a database's data files) disappears the moment the container is removed and replaced, which is why persistent state belongs in a volume, not the container itself.
- **Named volume** (Docker-managed, survives container removal, the default for databases) vs **bind mount** (maps an existing host path, best for source code and config) vs **`tmpfs`** (host memory only, gone the moment the container stops) — three different owners for the same problem.
- A **user-defined bridge network** gives containers DNS resolution by service name (`db`, `redis`) through Docker's embedded DNS; the **default `bridge` network** does not provide this and should not be relied on for service discovery.
- **`localhost` inside a container means that container itself**, not the host and not a sibling container — a dependency must always be addressed by its Compose service name (`db:5432`), never `localhost`.
- `ports:` **publishes** a port to the host (`HOST:CONTAINER`); `expose:` only documents/opens it to other containers on the same network without publishing it; a Dockerfile `EXPOSE` is just image metadata — none of the three alone guarantees reachability.
- `depends_on` with **`condition: service_healthy`** waits for a dependency's health check, not merely its start — startup order alone never proves a database is ready to accept connections, so the app should still retry its own connection.
- **Docker Compose** declares services, networks, and volumes (plus configs/secrets) together in one YAML file, and `docker compose up` builds, starts, and wires all of it in a single step.

```mermaid
flowchart LR
    U[Client] -->|HTTP :8080| N[Nginx Container]
    N -->|api:8000| A[FastAPI Container]
    A -->|db:5432| P[(PostgreSQL Container)]
    A -->|redis:6379| R[(Redis Container)]
    P --- V[(Named Volume)]

    subgraph Docker Compose Project
        N
        A
        P
        R
        V
    end
```

**Interview answer:** Persist state in named volumes rather than the container's writable layer, since that layer is destroyed with the container. Put the services on a user-defined bridge network so they can reach each other by service name through Docker's embedded DNS instead of hardcoded IPs, and only publish (`ports:`) the ports that actually need to be reachable from outside — everything else stays on `expose` or unpublished. Compose ties the services, networks, and volumes together in one YAML file, so the whole stack starts, networking included, with a single `docker compose up`.

**Gotcha:** `docker compose down` removes containers and networks but leaves named volumes on disk — it's `docker compose down --volumes` that deletes them, and reaching for that flag out of habit (a script, a shell alias, a CI cleanup step) is how a database ends up wiped.

---

# 1. Why These Three Topics Belong Together

A real application usually needs more than one container:

- An API or web application
- A database
- A cache or message broker
- A reverse proxy
- Background workers

These containers need three things:

1. **Volumes** to keep important data after containers are recreated.
2. **Networks** to let containers communicate securely.
3. **Docker Compose** to define and operate the complete multi-container application.

The important mental model is:

> **Compose creates containers, networks and volumes from one declarative YAML file.**

---

# 2. Docker Storage Fundamentals

## 2.1 Container Writable Layer

A container image is read-only. When Docker starts a container, it adds a thin writable layer above the image layers.

```mermaid
flowchart TB
    W[Container Writable Layer<br/>Temporary runtime changes]
    L3[Application Layer]
    L2[Dependency Layer]
    L1[Base Image Layer]

    W --> L3 --> L2 --> L1
```

Files written inside the container normally go into this writable layer — for example, `docker run --name demo alpine sh -c 'echo "hello" > /data.txt && sleep 300'` writes `/data.txt` inside that container. The file exists only while that container exists: removing it with `docker rm -f demo` deletes its writable layer along with it, and a new container created from the same image does not receive `/data.txt`.

### Why this matters

A database storing its files only in the container writable layer will lose those files when the container is removed and replaced.

Containers should therefore be treated as **replaceable compute units**, while important data should live outside their writable layers.

---

## 2.2 Storage Options

Docker provides three main ways to mount data into a container, plus the default of writing straight into the container's writable layer when no mount is used at all.

| Storage type | Managed by | Typical use | Persists after container removal |
|---|---|---|---:|
| Named or anonymous volume | Docker | Databases, queues, application state | Yes |
| Bind mount | Developer/host OS | Source code, local configuration | Yes |
| `tmpfs` mount | Host memory | Temporary sensitive or high-speed data | No |
| Container writable layer (no mount) | Docker (implicit) | No persistence required | No |

---

# 3. Docker Volumes

A Docker volume is a persistent data store managed by Docker. Its lifecycle is independent of the lifecycle of any single container.

```mermaid
sequenceDiagram
    participant D as Docker
    participant V as Named Volume
    participant C1 as Container v1
    participant C2 as Container v2

    D->>V: Create app_data
    D->>C1: Start and mount app_data
    C1->>V: Write files
    D->>C1: Remove container
    Note over V: Data remains
    D->>C2: Start replacement container
    C2->>V: Read existing files
```

## 3.1 Named, Anonymous, Bind and tmpfs Storage

### Named volume

A named volume has an explicit Docker-managed name.

```bash
docker volume create postgres_data

docker run -d \
  --name postgres \
  --mount type=volume,source=postgres_data,target=/var/lib/postgresql/data \
  postgres:17
```

Named volumes are the normal choice for persistent container data because they are:

- Managed through Docker commands
- Independent of a particular container
- Easy to attach to replacement containers
- Supported by volume drivers
- Less coupled to a host directory layout

### Anonymous volume

An anonymous volume has no user-defined name.

```bash
docker run -d \
  --name postgres \
  -v /var/lib/postgresql/data \
  postgres:17
```

Docker generates an identifier for it. Anonymous volumes persist after container removal unless removal is explicitly requested, but they are harder to identify and reuse.

Use named volumes for important application data.

### Bind mount

A bind mount maps an existing host path directly into a container.

```bash
docker run --rm \
  --mount type=bind,source="$(pwd)",target=/app \
  python:3.13-slim \
  python /app/main.py
```

Bind mounts are useful when:

- Editing source code on the host during development
- Mounting local configuration files
- Sharing generated files with host tools
- The exact host path is intentionally part of the design

They create tighter host coupling because the directory must exist and behave consistently on every machine.

### `tmpfs` mount

A `tmpfs` mount stores data in host memory rather than the container writable layer.

```bash
docker run --rm \
  --mount type=tmpfs,target=/app/runtime \
  alpine sh
```

It is useful for:

- Temporary runtime files
- Short-lived secrets
- Caches that should disappear when the container stops
- Reducing disk writes for disposable data

It is not persistent.

### Comparison

| Property | Named volume | Bind mount | `tmpfs` |
|---|---|---|---|
| Docker manages location | Yes | No | Runtime only |
| Host path required | No | Yes | No |
| Persistent | Yes | Yes | No |
| Portable Compose setup | High | Medium | High |
| Common database choice | Yes | Usually no | No |
| Common source-code choice | No | Yes | No |

---

## 3.2 Volume Commands

```bash
docker volume create app_data                              # create
docker volume ls                                            # list
docker volume inspect app_data                              # inspect: driver, labels, mount point, options
docker volume rm app_data                                   # remove (fails while a container is using it)
docker volume prune                                         # remove unused volumes — review before confirming
docker inspect postgres --format '{{json .Mounts}}'         # inspect a container's mounts
docker inspect postgres --format '{{json .Mounts}}' | jq    # same, pretty-printed when jq is installed
```

---

## 3.3 Mount Syntax

Docker supports `--mount` and `-v`/`--volume` as equivalent ways to attach the same mount. `--mount` is more verbose but easier to read in automation because each field is named.

```bash
# named volume: explicit form, then the compact equivalent
docker run --rm --mount type=volume,source=app_data,target=/app/data my-app:latest
docker run --rm -v app_data:/app/data my-app:latest

# read-only bind mount: explicit form, then the compact equivalent
docker run --rm --mount type=bind,source="$(pwd)/config",target=/app/config,readonly my-app:latest
docker run --rm -v "$(pwd)/config:/app/config:ro" my-app:latest
```

---

## 3.4 Read-Only Mounts

A container should receive write access only when it needs it.

```bash
docker run --rm \
  --mount type=bind,source="$(pwd)/nginx.conf",target=/etc/nginx/nginx.conf,readonly \
  nginx:alpine
```

Compose form:

```yaml
services:
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
```

A read-only mount reduces accidental changes and limits what a compromised process can modify.

---

## 3.5 Backup and Restore

A named volume is not automatically a complete backup strategy. Backups should be versioned, tested and stored outside the Docker host.

### Generic archive backup and restore

```bash
# backup: mount the volume read-only, mount a host backup dir, tar it out
docker run --rm \
  -v postgres_data:/source:ro \
  -v "$(pwd)/backups:/backup" \
  alpine \
  tar -czf /backup/postgres_data.tar.gz -C /source .

# restore: mount the volume read-write, wipe it, untar the archive back in
docker run --rm \
  -v postgres_data:/target \
  -v "$(pwd)/backups:/backup:ro" \
  alpine \
  sh -c 'rm -rf /target/* && tar -xzf /backup/postgres_data.tar.gz -C /target'
```

For databases, prefer database-aware tools such as:

- PostgreSQL: `pg_dump`, `pg_dumpall`, `pg_restore`
- MySQL: `mysqldump`, `mysql`
- MongoDB: `mongodump`, `mongorestore`

Database-aware backups understand consistency, transactions and logical database structures better than copying live data files.

---

## 3.6 Volume Permissions

A process inside a container runs with a user ID and group ID. The mounted files must be accessible to that identity.

Check the runtime user and the mounted directory's ownership:

```bash
docker exec my-container id                 # runtime uid/gid
docker exec my-container ls -ld /app/data   # ownership of the mounted directory
```

A common production pattern is to run the application as a non-root user and ensure the mounted directory is owned by that user's UID/GID.

Example Dockerfile fragment:

```dockerfile
RUN addgroup --system app && adduser --system --ingroup app app
RUN mkdir -p /app/data && chown -R app:app /app
USER app
```

When a bind mount replaces `/app/data`, its host permissions still matter. Creating the directory during image build does not override permissions of a mounted host directory.

---

# 4. Docker Networking

Container networking allows containers to communicate with:

- Other containers
- The Docker host
- External systems
- Clients reaching published ports

A container normally has its own network namespace, interfaces, routing table and port space.

## 4.1 Core Network Drivers

| Driver | Scope and purpose | Common use |
|---|---|---|
| `bridge` | Containers on one Docker host | Local development and single-host deployments |
| `host` | Container shares host networking | Specialized performance or network tooling cases |
| `none` | Networking disabled | Fully isolated processing |
| `overlay` | Multi-host container communication | Docker Swarm services |
| `macvlan` | Container appears as a device on the physical network | Legacy or network-appliance integration |
| `ipvlan` | Layer 2/3 integration with less MAC-address usage | Advanced network environments |

For normal Compose applications running on one machine, user-defined **bridge networks** are the most common choice.

---

## 4.2 Bridge Networking

Docker creates a default network named `bridge`, but user-defined bridge networks provide better service discovery and isolation: `docker network create app_network`.

Start containers on it by name:

```bash
docker run -d \
  --name redis \
  --network app_network \
  redis:8-alpine

docker run --rm \
  --network app_network \
  redis:8-alpine \
  redis-cli -h redis ping
```

The second container reaches Redis by the container name `redis`. Manage networks with:

```bash
docker network ls                                          # list
docker network inspect app_network                         # config, connected containers, IPAM
docker network connect app_network existing_container      # attach a running container
docker network disconnect app_network existing_container   # detach a running container
docker network rm app_network                              # remove
```

---

## 4.3 DNS and Service Discovery

Containers on a user-defined network can discover one another through Docker's embedded DNS.

In Compose, the **service name becomes the normal hostname**.

```yaml
services:
  api:
    environment:
      DATABASE_URL: postgresql://app:secret@db:5432/appdb
      REDIS_URL: redis://redis:6379/0

  db:
    image: postgres:17

  redis:
    image: redis:8-alpine
```

The API connects to:

- PostgreSQL using `db:5432`
- Redis using `redis:6379`

It should not use container IP addresses because container IPs may change after recreation.

```mermaid
flowchart LR
    A[API Service] -->|DNS lookup: db| D[Docker Embedded DNS]
    D -->|Current container IP| A
    A -->|TCP 5432| P[PostgreSQL Service]
```

### The `localhost` rule

Inside a container, `localhost` means **that same container**. An API container using `postgresql://app:secret@localhost:5432/appdb` searches for PostgreSQL inside itself, not inside the `db` container — use the Compose service name instead: `postgresql://app:secret@db:5432/appdb`.

---

## 4.4 Ports, `expose` and `EXPOSE`

These concepts are related but not identical.

### Published port

```yaml
services:
  api:
    ports:
      - "8000:8000"
```

`HOST_PORT:CONTAINER_PORT` — traffic sent to the Docker host on port `8000` is forwarded to port `8000` in the container. Bind only to localhost with `ports: ["127.0.0.1:8000:8000"]` to keep it off every other host interface.

```mermaid
flowchart LR
    C[Browser] -->|localhost:8000| H[Docker Host Port 8000]
    H -->|NAT/forwarding| A[API Container Port 8000]
```

### `expose` vs `EXPOSE`

`expose: ["8000"]` in Compose documents and makes the container port available to linked Compose services, without publishing it to the host — containers on the same network can usually reach the target container port even without `expose`. A Dockerfile `EXPOSE 8000` is only image metadata documenting the intended listening port; neither form publishes the port by itself.

### Practical difference

| Configuration | Reachable from other containers on same network | Reachable from host |
|---|---:|---:|
| App listens on container port only | Yes | No |
| `expose: 8000` | Yes | No |
| `ports: ["8000:8000"]` | Yes | Yes |
| Dockerfile `EXPOSE 8000` only | Yes, if app listens | No |

---

## 4.5 Connecting to the Host

A container sometimes needs to call a service running directly on the developer's host. On Docker Desktop, use `host.docker.internal` — for example, `http://host.docker.internal:9000`.

On Linux Engine, this mapping can be added explicitly when required: `docker run --add-host=host.docker.internal:host-gateway my-app`.

Compose form:

```yaml
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Do not use this for communication between Compose services. Use service names instead.

---

## 4.6 Network Isolation

A service can join multiple networks. This allows a reverse proxy to reach the API without giving the database direct access to the public-facing network.

```mermaid
flowchart LR
    U[Client] --> N[Nginx]

    subgraph frontend_network
        N
        A[API]
    end

    subgraph backend_network
        A
        D[(PostgreSQL)]
        R[(Redis)]
    end
```

Compose configuration:

```yaml
services:
  nginx:
    networks:
      - frontend

  api:
    networks:
      - frontend
      - backend

  db:
    networks:
      - backend

  redis:
    networks:
      - backend

networks:
  frontend:
  backend:
    internal: true
```

An internal network is isolated from external connectivity at the Docker network level. The exact application requirements should still be considered, because a service on only an internal network cannot directly reach external APIs.

---

# 5. Docker Compose

Docker Compose defines and runs a multi-container application from a YAML model. The modern command is `docker compose`; the older standalone `docker-compose` command is legacy. Modern Compose uses the **Compose Specification**. A top-level `version:` field is no longer required and is considered obsolete by current Compose implementations.

---

## 5.1 Compose Application Model

A Compose project can define:

- **Services** — application components that run as containers
- **Networks** — communication boundaries
- **Volumes** — persistent data stores
- **Configs** — non-sensitive configuration data
- **Secrets** — sensitive data mounted or provided through supported mechanisms

```mermaid
flowchart TB
    C[compose.yaml]
    C --> S[Services]
    C --> N[Networks]
    C --> V[Volumes]
    C --> G[Configs]
    C --> X[Secrets]

    S --> API[api]
    S --> DB[db]
    S --> REDIS[redis]
    S --> NGINX[nginx]
```

Compose uses the directory name as the default project name, and project resources commonly receive names like `myproject_api_1`, `myproject_backend`, and `myproject_postgres_data` — actual naming depends on Compose and any explicit `name` or project options. Set a project name explicitly with `docker compose -p billing-api up -d`.

---

## 5.2 Compose File Structure

A minimal example:

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
    image: postgres:17
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - backend

networks:
  backend:

volumes:
  postgres_data:
```

- **`services`** — each service defines how one application component should run.
- **`networks`** — top-level networks define reusable network resources for services.
- **`volumes`** — top-level volumes define persistent named volumes.
- **`name`** — the optional top-level field that sets the Compose project name.

---

## 5.3 Service Configuration

Common service fields:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    image: example/api:1.0.0
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000
    working_dir: /app
    environment:
      APP_ENV: development
    env_file:
      - .env
    ports:
      - "8000:8000"
    expose:
      - "8000"
    volumes:
      - ./app:/app/app
    networks:
      - backend
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 15s
```

### `build` versus `image`

`build: .` builds an image from local source, while `image: example/api:1.0.0` uses a named image. A service can include both: Compose can build the image and tag it with the specified name.

### `command` and `entrypoint`

`command` overrides the image's default command. `entrypoint` overrides the image's entrypoint — use it only when the image's normal startup design needs to be replaced.

### `restart`

Common values include:

- `no`
- `always`
- `on-failure`
- `unless-stopped`

Restart policies improve process recovery on one host but do not replace health monitoring, orchestration or multi-host high availability.

### Resource controls

Local Compose supports service-level controls such as:

```yaml
services:
  api:
    cpus: 1.0
    mem_limit: 512m
```

The `deploy` section belongs to the Compose Deploy Specification and is especially associated with orchestrated deployments. Support for individual fields depends on the runtime and command being used.

---

## 5.4 Startup Order and Health Checks

A basic dependency:

```yaml
services:
  api:
    depends_on:
      - db
```

This controls startup order, but simple startup order alone does not prove that the database is ready to accept connections.

Use a health check and a readiness condition:

```yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
```

Even with dependency health checks, the application should implement connection retries. Dependencies can fail or restart after initial startup.

### Health check state flow

```mermaid
stateDiagram-v2
    [*] --> Starting
    Starting --> Healthy: Check succeeds
    Starting --> Unhealthy: Retry limit reached
    Healthy --> Unhealthy: Consecutive checks fail
    Unhealthy --> Healthy: Check succeeds again
```

---

## 5.5 Environment Variables and Secrets

### Inline environment values

```yaml
services:
  api:
    environment:
      APP_ENV: development
      LOG_LEVEL: INFO
```

### `.env` interpolation

`.env`:

```dotenv
API_PORT=8000
POSTGRES_DB=appdb
POSTGRES_USER=app
```

`compose.yaml`:

```yaml
services:
  api:
    ports:
      - "${API_PORT:-8000}:8000"

  db:
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
```

`${API_PORT:-8000}` means use `API_PORT`, or default to `8000` when it is unset or empty according to Compose interpolation rules.

### `env_file`

```yaml
services:
  api:
    env_file:
      - .env
```

This passes values into the container environment. It is different from Compose's own interpolation of `${VARIABLE}` in the YAML.

### Secrets

Avoid committing production secrets to Git or baking them into images.

Local Compose example:

```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets:
      - db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt
```

The secret is mounted into the container as a file, normally under `/run/secrets/`.

For AWS deployments, use services such as:

- AWS Secrets Manager
- AWS Systems Manager Parameter Store
- IAM roles for workloads

Avoid treating a plain `.env` file as secure secret storage.

---

## 5.6 Profiles, Overrides and Watch

### Profiles

Profiles allow optional services to run only when requested.

```yaml
services:
  api:
    build: .

  adminer:
    image: adminer
    profiles:
      - debug
    ports:
      - "8081:8080"
```

Run the normal stack with `docker compose up -d`, or include debug tools with `docker compose --profile debug up -d`.

### Multiple Compose files

Base file:

```yaml
# compose.yaml
services:
  api:
    image: example/api:1.0.0
```

Development override:

```yaml
# compose.dev.yaml
services:
  api:
    build: .
    volumes:
      - ./app:/app/app
```

Run them together with `docker compose -f compose.yaml -f compose.dev.yaml up --build` — later files extend or override earlier files according to Compose merge rules. Inspect the final merged configuration with `docker compose -f compose.yaml -f compose.dev.yaml config`.

### Compose Watch

Compose Watch can synchronize or rebuild services when source files change.

```yaml
services:
  api:
    build: .
    develop:
      watch:
        - action: sync
          path: ./app
          target: /app/app
        - action: rebuild
          path: ./pyproject.toml
```

Run with `docker compose up --watch`. This can provide a cleaner cross-platform development workflow than broad bind mounts, depending on the application and Docker Desktop environment.

---

# 6. Complete Practical Example

This example contains:

- Nginx as the public entry point
- FastAPI as the application service
- PostgreSQL with a persistent named volume
- Redis on an internal backend network
- Health checks and dependency conditions
- A development bind mount for source code

## 6.1 Project Structure

```text
docker-compose-demo/
├── app/
│   ├── main.py
│   └── requirements.txt
├── nginx/
│   └── nginx.conf
├── .env.example
├── compose.yaml
└── Dockerfile
```

## 6.2 FastAPI Application

`app/main.py`:

```python
import os

from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "healthy"}

@app.get("/")
def root() -> dict[str, str]:
    return {
        "message": "Docker Compose application is running",
        "database_host": os.getenv("DATABASE_HOST", "not-configured"),
        "redis_host": os.getenv("REDIS_HOST", "not-configured"),
    }
```

`app/requirements.txt`:

```text
fastapi
uvicorn[standard]
```

## 6.3 Dockerfile

```dockerfile
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app app/ ./app/

USER app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 6.4 Nginx Configuration

`nginx/nginx.conf`:

```nginx
events {}

http {
    upstream api_backend {
        server api:8000;
    }

    server {
        listen 80;

        location / {
            proxy_pass http://api_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}
```

Nginx uses `api:8000`, where `api` is resolved by Docker DNS.

## 6.5 Environment Template

`.env.example`:

```dotenv
APP_PORT=8080
POSTGRES_DB=appdb
POSTGRES_USER=app
POSTGRES_PASSWORD=replace-for-local-development
```

Copy it locally with `cp .env.example .env`. Do not commit real credentials.

## 6.6 Compose File

`compose.yaml`:

```yaml
name: docker-compose-demo

services:
  nginx:
    image: nginx:alpine
    ports:
      - "127.0.0.1:${APP_PORT:-8080}:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      api:
        condition: service_healthy
    networks:
      - frontend

  api:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      DATABASE_HOST: db
      REDIS_HOST: redis
    expose:
      - "8000"
    volumes:
      - ./app:/app/app:ro
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s
    networks:
      - frontend
      - backend

  db:
    image: postgres:17
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    networks:
      - backend

  redis:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
    networks:
      - backend

networks:
  frontend:
  backend:
    internal: true

volumes:
  postgres_data:
  redis_data:
```

## 6.7 What Compose Creates

```mermaid
flowchart TB
    H[Host: 127.0.0.1:8080]

    subgraph frontend network
        N[nginx:80]
        A[api:8000]
    end

    subgraph internal backend network
        A2[api]
        D[db:5432]
        R[redis:6379]
    end

    PV[(postgres_data)]
    RV[(redis_data)]
    BM[Bind Mount<br/>./app -> /app/app:ro]

    H --> N
    N --> A
    A2 --> D
    A2 --> R
    D --- PV
    R --- RV
    BM --- A
```

The API service appears in both networks. It acts as the controlled communication path between the public-facing proxy and private data services.

## 6.8 Run the Application

```bash
docker compose config            # validate the Compose model
docker compose up -d --build     # build and start
docker compose ps                # check status
docker compose logs -f           # follow logs
docker compose down              # stop containers, keep volumes
docker compose down --volumes    # stop and delete project volumes (drops db/redis data)
```

Open `http://localhost:8080`.

---

# 7. Compose Lifecycle and Daily Commands

## 7.1 Start and Stop

```bash
docker compose up               # create/start in foreground
docker compose up -d            # create/start in background
docker compose up -d --build    # build before starting
docker compose stop             # stop without deleting containers
docker compose restart          # restart existing containers
docker compose down             # stop and remove project containers/networks
```

## 7.2 Inspect State

```bash
docker compose ps        # list service containers
docker compose config    # render resolved configuration
docker compose images    # list images used by services
docker compose top       # show running processes
```

## 7.3 Logs

```bash
docker compose logs                   # all services
docker compose logs -f                # follow all logs
docker compose logs -f api            # follow one service
docker compose logs --tail=100 api    # last 100 lines
docker compose logs -t api            # include timestamps
```

## 7.4 Execute Commands

```bash
docker compose exec api sh                    # run inside an existing service container
docker compose run --rm api python -m pytest   # run a new one-off container from a service definition
```

`exec` uses an already-running container. `run` creates a new one-off container.

## 7.5 Build and Pull

```bash
docker compose build                 # build all buildable services
docker compose build --no-cache      # build without cache
docker compose pull                  # pull service images
docker compose up -d --pull always   # pull and start
```

## 7.6 Scale a Stateless Service

Scale with `docker compose up -d --scale worker=3`. A scaled service should not set a fixed `container_name`, and host-port mappings must be designed carefully because multiple containers cannot all bind the same host port.

## 7.7 Remove Resources

```bash
docker compose rm                  # remove stopped service containers
docker compose down                # remove containers and default project network
docker compose down --volumes      # also remove named project volumes
docker compose down --rmi local    # also remove images created/used by the project
```

---

# 8. AWS Mapping

Docker concepts remain useful on AWS, but production services often replace host-local resources with managed or orchestrated equivalents.

## 8.1 Concept Mapping

| Local Docker concept | Common AWS equivalent or relationship |
|---|---|
| Docker image | Image stored in Amazon ECR |
| Docker host | EC2 instance, ECS container instance or managed runtime |
| Compose service | ECS task/container definition concepts or an Elastic Beanstalk Docker service |
| Named volume on one host | EBS-backed host storage or managed storage depending on runtime |
| Shared file storage | Amazon EFS |
| Docker bridge network | Local host networking; production networking is normally integrated with a VPC |
| Published port | ECS port mapping plus security groups/load balancer rules |
| Docker DNS | ECS service discovery, Cloud Map or load-balanced service endpoints |
| `.env` secret | AWS Secrets Manager or Systems Manager Parameter Store |
| Compose restart policy | ECS service scheduler/replacement behavior or platform health management |

The mapping is conceptual, not always one-to-one.

---

## 8.2 Storage on AWS

### Amazon EBS

EBS is block storage attached within an Availability Zone. It commonly supports persistent storage for an EC2 host.

Consider it when:

- A workload needs block-device semantics
- Storage is associated with an EC2-based deployment
- One-host or carefully managed attachment patterns are acceptable

A Docker named volume located on an EC2 instance may ultimately reside on the instance's underlying EBS filesystem. Docker alone does not automatically make that volume portable across EC2 instances.

### Amazon EFS

EFS provides network file storage and can be mounted by multiple supported compute resources.

Consider it when:

- Multiple tasks or instances need shared files
- Data must survive task replacement across hosts
- POSIX-style shared filesystem behavior is suitable

### Managed databases

For production databases, Amazon RDS or Aurora is often preferable to running PostgreSQL or MySQL inside a Compose-managed container because managed services provide capabilities such as automated backups, patching, monitoring and high-availability options.

This is an architectural choice, not a rule. The required control, cost, scale and operational responsibility determine the correct option.

---

## 8.3 Networking on AWS

A production container workload commonly interacts with:

- VPC subnets
- Route tables
- Security groups
- Network ACLs
- Application or Network Load Balancers
- Private DNS and service discovery

With ECS `awsvpc` networking, a task receives VPC networking through an elastic network interface. Security-group rules then become an important part of service-to-service and inbound connectivity.

```mermaid
flowchart LR
    I[Internet] --> ALB[Application Load Balancer]
    ALB -->|Security Group Rule| API[ECS API Tasks]
    API -->|Private subnet + SG rule| RDS[(Amazon RDS)]
    API -->|Private endpoint/service| CACHE[(ElastiCache)]
    API --> SM[AWS Secrets Manager]
```

Do not assume that a port exposed in a container image is reachable from the internet. Reachability depends on task port mappings, load balancers, subnet routing, security groups and the application listener.

---

## 8.4 Compose on AWS

Compose is excellent for:

- Local development
- CI integration environments
- Single-host internal tools
- Small applications on an EC2 instance
- Docker-based Elastic Beanstalk deployments that support Compose

For larger production systems, AWS commonly uses ECS or EKS as the deployment control plane rather than relying on Compose alone.

A current AWS option is deploying a Docker Compose application to an Elastic Beanstalk Docker environment. For ECS-native deployments, the application is normally represented through ECS task definitions, services, networking and storage configuration rather than directly operating the local Compose model.

---

# 9. Production Design Guidance

## 9.1 Keep Containers Replaceable

Persist important state outside the container writable layer: `replaceable container + externalized state = safer deployments`. Use named or managed storage for persistent data and rebuild containers from images rather than modifying live containers manually.

## 9.2 Separate Stateful and Stateless Components

A web/API service should usually be stateless so multiple replicas can serve requests.

State should live in appropriate systems such as:

- Database
- Object storage
- Cache
- Queue
- Shared persistent filesystem when genuinely required

Local session state inside one API container makes horizontal scaling and replacement harder.

## 9.3 Publish Only Required Ports

In the complete example:

- Nginx publishes a host port.
- API is reachable only through the Compose frontend network.
- PostgreSQL and Redis are reachable only through the backend network.

This reduces unnecessary attack surface.

## 9.4 Use Service Names, Not Container IPs

Correct: `postgresql://db:5432/appdb`. Fragile: `postgresql://172.20.0.4:5432/appdb`. Container addresses are runtime details and can change.

## 9.5 Add Health Checks and Application Retries

Health checks improve visibility and dependency coordination. Application retries handle temporary unavailability during restarts, failovers and network interruptions.

A robust database connection flow is:

```mermaid
flowchart TD
    A[Application starts] --> B[Attempt database connection]
    B -->|Success| C[Serve requests]
    B -->|Temporary failure| D[Backoff]
    D --> E{Retry limit reached?}
    E -->|No| B
    E -->|Yes| F[Fail clearly / allow restart]
```

Use bounded exponential backoff rather than tight infinite retry loops.

## 9.6 Pin Image Versions

Prefer a controlled version, `image: postgres:17.5`, over an uncontrolled floating tag such as `image: postgres:latest`. For stronger reproducibility, production pipelines can pin an image digest: `image: postgres:17.5@sha256:...`. Update versions deliberately through tested dependency-management processes.

## 9.7 Keep Secrets Out of Images and Git

Do not place secrets in:

- Dockerfiles
- Image build arguments intended for normal runtime secrets
- Committed Compose files
- Committed `.env` files
- Public image registries

Use runtime secret mechanisms and least-privilege IAM access on AWS.

## 9.8 Use Read-Only Filesystems Where Practical

A hardened service can use:

```yaml
services:
  api:
    read_only: true
    tmpfs:
      - /tmp
```

The application must be designed so required writable paths use explicit volumes or temporary mounts.

## 9.9 Run as a Non-Root User

Set a non-root `USER` in the image and ensure mounted directory permissions match that user.

## 9.10 Set Resource Boundaries

Resource limits prevent one container from consuming all host memory or CPU. In orchestrated environments, define task or pod requests and limits according to measured usage.

## 9.11 Treat Volumes as Data, Not Backups

A volume survives container replacement, but it can still be lost through:

- Host failure
- Accidental deletion
- Filesystem corruption
- Application errors
- Ransomware or unauthorized access

Use tested backups, retention rules and recovery procedures.

## 9.12 Keep Development and Production Configuration Separate

Development may use:

- Bind mounts
- Auto-reload
- Debug profiles
- Local database containers

Production may use:

- Immutable images
- Managed databases
- External secret stores
- Load balancers
- Centralized logging
- Orchestrator health and deployment controls

Use Compose overrides or separate deployment definitions without duplicating every common setting.

---

# 10. Troubleshooting Workflow

## 10.1 Container Does Not Start

```bash
docker compose ps -a
docker compose logs --tail=200 service_name
docker compose config
```

Check:

- Image/build errors
- Invalid command or entrypoint
- Missing variables
- Permission failures
- Port conflicts
- Health-check failures

## 10.2 Service Cannot Reach Another Service

```bash
docker compose exec api getent hosts db        # DNS resolves to an IP?
docker compose exec api python -c \
  "import socket; socket.create_connection(('db', 5432), timeout=3); print('connected')"  # TCP reachable?
docker network ls
docker network inspect docker-compose-demo_backend    # both services on the network?
```

Check that:

- Both services share a network
- The client uses the service name
- The target process listens on `0.0.0.0`, not only `127.0.0.1`
- The target port is correct
- The target service is healthy

## 10.3 Published Port Is Not Reachable

```bash
docker compose ps
docker compose port nginx 80
lsof -i :8080    # macOS/Linux: what's bound to the host port
```

Check:

- Host port mapping
- Whether another process already owns the host port
- Host bind address such as `127.0.0.1`
- Firewall/security-group rules in remote environments
- Whether the process listens on the container port

## 10.4 Data Disappeared

Inspect mounts:

```bash
docker compose config
docker compose exec db mount
docker volume ls
docker volume inspect docker-compose-demo_postgres_data
```

Check whether:

- The application wrote to the mounted target path
- A different volume name/project name was used
- `docker compose down --volumes` was run
- An anonymous volume replaced the expected named volume
- The database image changed its required data directory

## 10.5 Permission Denied on a Mount

```bash
docker compose exec api id
docker compose exec api ls -ld /app /app/data
ls -ld ./data    # for bind mounts, also check the host path
```

Align ownership and permissions with the runtime user. Avoid solving every permission issue by running the container as root.

## 10.6 Compose Uses Unexpected Values

```bash
docker compose config                 # render the final model
docker compose config --environment   # show the environment used for interpolation
```

Check:

- Shell environment
- `.env` location
- `--env-file`
- Multiple `-f` files and their order
- Variable defaults and escaping

## 10.7 Clean Rebuild

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
docker compose down --volumes    # only if data loss is acceptable
```

---

# 11. Official References

## Docker

- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker storage overview](https://docs.docker.com/engine/storage/)
- [Docker networking overview](https://docs.docker.com/engine/network/)
- [Docker network drivers](https://docs.docker.com/engine/network/drivers/)
- [Docker bridge network driver](https://docs.docker.com/engine/network/drivers/bridge/)
- [Docker Compose](https://docs.docker.com/compose/)
- [Compose file reference](https://docs.docker.com/reference/compose-file/)
- [Networking in Compose](https://docs.docker.com/compose/how-tos/networking/)
- [Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)
- [Docker Compose CLI reference](https://docs.docker.com/reference/cli/docker/compose/)

## AWS

- [Deploy a Docker Compose application to Elastic Beanstalk](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/docker-compose-quickstart.html)
- [Elastic Beanstalk Docker configuration](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/single-container-docker-configuration.html)
- [Amazon ECS task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking.html)
- [Amazon ECS task storage](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html)
- [Amazon EFS](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
- [Amazon EBS](https://docs.aws.amazon.com/ebs/latest/userguide/what-is-ebs.html)

---

> **Final mental model:** A container should be replaceable, its persistent data should live in a volume or managed data service, its communication should happen through intentional networks, and the complete local application should be reproducibly described through Compose.
