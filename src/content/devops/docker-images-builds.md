---
title: "Docker Images & Builds"
group: "Docker"
order: 1
---

# Docker: Image vs Container, Dockerfile, Layers, and Multi-Stage Builds

> **Category:** AWS, Docker & DevOps  
> **Level:** Intermediate developer (3+ years experience)  
> **Last verified:** 30 July 2026  
> **Goal:** Understand how Docker packages an application, how images and containers differ, how Dockerfiles create image layers, and how multi-stage builds produce smaller and safer production images.

---

# 1. Docker in One Picture

Docker packages an application and everything required to run it into an **image**. Docker then starts an isolated process from that image, called a **container**.

```mermaid
flowchart TD
    A[Application source code] -->|docker build| B["Docker Image<br/>app code, runtime, dependencies,<br/>config defaults, startup command"]
    B -->|docker run| C["Running Container<br/>isolated process, image layers,<br/>writable layer, runtime config"]
```

A simple mental model is:

```mermaid
flowchart LR
    A[Dockerfile<br/>Recipe] --> B[Image<br/>Package] --> C[Container<br/>Running instance]
```

- A **Dockerfile** describes how to build an image.
- An **image** is the packaged application template.
- A **container** is a running or stopped instance created from an image.

---

# 2. Docker Image

A Docker image is a standardized, immutable package containing the files and configuration needed to start a container.

A typical application image may contain:

- A minimal Linux filesystem
- A language runtime such as Python, Node.js, Java, or Go
- Application dependencies
- Application source code or compiled binaries
- Environment variable defaults
- Metadata such as exposed ports
- A default startup command

For example, a FastAPI image might contain:

```text
python:3.13-slim base filesystem
        +
Python packages from requirements.txt
        +
FastAPI application source code
        +
Uvicorn startup command
```

## 2.1 Images are immutable

After an image is built, Docker does not modify that image directly. A new build creates a new image or reuses existing layers and adds new layers.

This gives predictable deployment behavior:

```mermaid
flowchart TD
    A[Same image digest] --> B[Local development]
    A --> C[Test environment]
    A --> D[Staging environment]
    A --> E[Production environment]
```

The application package remains identical across environments. Runtime settings such as database URLs, credentials, replica counts, and resource limits are supplied separately.

## 2.2 An image is not a running process

An image consumes storage, but it does not consume application CPU or memory merely because it exists.

```bash
# Show locally available images
docker image ls
```

Example output:

```text
REPOSITORY       TAG       IMAGE ID       CREATED          SIZE
orders-api       1.0.0     a1b2c3d4e5f6   2 minutes ago    185MB
python           3.13-slim 7e8f9a0b1c2d   5 days ago       125MB
```

---

# 3. Docker Container

A container is an isolated process created from an image.

When Docker starts a container, it combines:

1. The image's read-only layers
2. A thin writable container layer
3. Runtime configuration supplied to `docker run`, Docker Compose, ECS, Kubernetes, or another orchestrator
4. Linux isolation features such as namespaces and control groups

```text
+----------------------------------+
| Writable container layer         |  ← logs/temp/runtime file changes
+----------------------------------+
| Application source layer         |
+----------------------------------+
| Dependency layer                 |
+----------------------------------+
| Runtime/base image layers        |
+----------------------------------+
```

## 3.1 A container has a lifecycle

A container can be:

- Created
- Running
- Paused
- Stopped
- Restarted
- Removed

```bash
# Create and start a container
docker run --name orders-api -p 8000:8000 orders-api:1.0.0

# Show running containers
docker ps

# Show running and stopped containers
docker ps -a

# Stop the container
docker stop orders-api

# Start the same stopped container
docker start orders-api

# Remove the container
docker rm orders-api
```

## 3.2 Multiple containers can use the same image

One image can create many independent containers.

```mermaid
flowchart TD
    I["orders-api:1.0.0 image"] --> A[Container A<br/>port 8001]
    I --> B[Container B<br/>port 8002]
    I --> C[Container C<br/>port 8003]
```

Each container receives its own writable layer, process namespace, network configuration, and runtime environment.

```bash
docker run -d -p 8001:8000 orders-api:1.0.0
docker run -d -p 8002:8000 orders-api:1.0.0
docker run -d -p 8003:8000 orders-api:1.0.0
```

This is the basic idea behind horizontally scaling stateless services.

## 3.3 Container data is usually temporary

Files written inside the container's writable layer are tied to that container. Removing the container removes that writable layer.

Persistent data should normally be stored in:

- Docker volumes
- Bind mounts
- Object storage such as Amazon S3
- External databases such as Amazon RDS or DynamoDB
- Managed file storage such as Amazon EFS

A database should not depend on its container writable layer for durable production data.

---

# 4. Docker Image vs Container

| Aspect | Docker Image | Docker Container |
|---|---|---|
| Meaning | Packaged application template | Instance created from an image |
| State | Immutable/read-only | Has a writable runtime layer |
| Runtime | Does not run by itself | Runs one main process and its child processes |
| Resource use | Primarily disk storage | CPU, memory, network, and disk I/O while running |
| Creation | Built from a Dockerfile or imported | Created using `docker run` or an orchestrator |
| Multiplicity | One image can be reused | Many containers can use the same image |
| Lifetime | Remains until removed | Can be created, stopped, restarted, and deleted |
| Analogy | Class or executable package | Object or running process |
| Example | `orders-api:1.0.0` | `orders-api-prod-7f9b` |

## 4.1 Practical analogy

```text
Image     = Application installer/template
Container = Installed and running application instance
```

Another useful analogy:

```text
Image     = Class
Container = Object created from that class
```

The analogy is not technically exact, but it is useful when first explaining the relationship.

## 4.2 Important distinction

Deleting a container does not delete its source image.

```bash
docker rm orders-api
docker image ls
```

The image remains available and can create another container.

Similarly, deleting an image generally requires that no existing container still depends on it, unless removal is forced.

---

# 5. From Source Code to a Running Container

The normal workflow is:

```mermaid
flowchart TD
    A["Source code + Dockerfile + build context"] -->|docker build| B[Docker image]
    B -->|tag and push to registry| C["Docker Hub / Amazon ECR / GHCR"]
    C -->|pull and run| D[Container]
```

## 5.1 Build an image

```bash
docker build -t orders-api:1.0.0 .
```

Meaning:

- `docker build`: start an image build
- `-t orders-api:1.0.0`: assign repository name and tag
- `.`: use the current directory as the build context

## 5.2 Run a container

```bash
docker run \
  --name orders-api \
  -p 8000:8000 \
  -e APP_ENV=development \
  orders-api:1.0.0
```

Meaning:

- `--name`: gives the container a readable name
- `-p 8000:8000`: maps host port `8000` to container port `8000`
- `-e`: sets a runtime environment variable
- `orders-api:1.0.0`: image used to create the container

## 5.3 Detached mode

```bash
docker run -d --name orders-api -p 8000:8000 orders-api:1.0.0
```

The `-d` option runs the container in the background.

```bash
docker logs -f orders-api
```

---

# 6. Dockerfile Fundamentals

A Dockerfile is a text document containing instructions Docker uses to assemble an image.

A simple FastAPI Dockerfile:

```dockerfile
FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Build it:

```bash
docker build -t fastapi-demo:1.0.0 .
```

Run it:

```bash
docker run --rm -p 8000:8000 fastapi-demo:1.0.0
```

## 6.1 How Docker reads the Dockerfile

Docker processes instructions in order.

```mermaid
flowchart TD
    A[FROM] --> B[WORKDIR]
    B --> C[COPY requirements.txt]
    C --> D[RUN pip install]
    D --> E[COPY application code]
    E --> F[EXPOSE]
    F --> G[CMD]
```

Most filesystem-changing instructions create or contribute to image layers. Docker may reuse cached results when an instruction and its required inputs have not changed.

## 6.2 Dockerfile syntax directive

Modern Dockerfiles commonly begin with:

```dockerfile
# syntax=docker/dockerfile:1
```

This selects the current stable Dockerfile frontend syntax and enables current BuildKit Dockerfile features supported by the builder.

```dockerfile
# syntax=docker/dockerfile:1

FROM python:3.13-slim
```

---

# 7. Important Dockerfile Instructions

## 7.1 `FROM`

Defines the base image and starts a build stage.

```dockerfile
FROM python:3.13-slim
```

Every new `FROM` begins a new stage:

```dockerfile
FROM node:24-alpine AS build
# Build stage

FROM nginx:alpine AS runtime
# Runtime stage
```

A base image supplies the starting filesystem, tools, libraries, and metadata.

Common choices:

```dockerfile
FROM python:3.13-slim
FROM node:24-alpine
FROM eclipse-temurin:21-jre
FROM nginx:alpine
FROM scratch
```

Use a base image that is:

- Official or from a trusted publisher
- Appropriate for the runtime
- Small enough for the application
- Compatible with required native libraries
- Regularly updated

## 7.2 `WORKDIR`

Sets the working directory for subsequent instructions such as `RUN`, `COPY`, `CMD`, and `ENTRYPOINT`.

```dockerfile
WORKDIR /app
```

Prefer `WORKDIR` instead of repeatedly using `cd`:

```dockerfile
# Preferred
WORKDIR /app
RUN python -m compileall .

# Less clear
RUN cd /app && python -m compileall .
```

If the directory does not exist, Docker creates it.

## 7.3 `COPY`

Copies files from the build context into the image.

```dockerfile
COPY requirements.txt /app/requirements.txt
COPY app/ /app/app/
```

When `WORKDIR /app` is already set:

```dockerfile
COPY requirements.txt .
COPY app/ ./app/
```

`COPY` is generally preferred for ordinary local file copying because its behavior is explicit.

## 7.4 `ADD`

`ADD` can copy local files like `COPY`, but it also supports extra behavior such as automatic local tar extraction and remote/Git sources in supported syntax.

```dockerfile
ADD application.tar.gz /app/
```

Use `COPY` for normal file transfer. Use `ADD` only when its additional behavior is intentional.

## 7.5 `RUN`

Executes a command during the image build.

```dockerfile
RUN pip install --no-cache-dir -r requirements.txt
```

The command runs while building the image, not whenever a container starts.

```text
RUN  → build time
CMD  → container start time
```

Example package installation:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
```

Combining related package operations in one `RUN` instruction prevents stale package index caching and avoids retaining unnecessary package metadata in a later layer.

## 7.6 `ENV`

Defines an environment variable that becomes part of the image configuration and is available in later build instructions and running containers.

```dockerfile
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
```

A runtime value can override it:

```bash
docker run -e APP_ENV=production orders-api:1.0.0
```

Do not bake secrets into `ENV` because image metadata and layers may expose them.

## 7.7 `ARG`

Defines a build-time variable.

```dockerfile
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=$APP_VERSION
```

Build with:

```bash
docker build --build-arg APP_VERSION=1.4.2 -t orders-api:1.4.2 .
```

`ARG` is mainly for build configuration. It is not a secure secret mechanism. Sensitive build credentials should use BuildKit secret mounts.

## 7.8 `EXPOSE`

Documents the network port the application expects to listen on.

```dockerfile
EXPOSE 8000
```

`EXPOSE` does not publish the port to the host.

You still need:

```bash
docker run -p 8000:8000 orders-api:1.0.0
```

```text
EXPOSE 8000       = image metadata/documentation
-p 8000:8000      = actual host-to-container port mapping
```

## 7.9 `USER`

Sets the user for subsequent build instructions and for the container's main process.

```dockerfile
RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser

USER appuser
```

Running as a non-root user reduces the impact of a compromised application process.

## 7.10 `LABEL`

Adds metadata to the image.

```dockerfile
LABEL org.opencontainers.image.title="Orders API" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="company/orders-api"
```

## 7.11 `HEALTHCHECK`

Defines a command that checks whether the application inside the container is healthy.

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"
```

In orchestrated environments, health checks are often configured in ECS task definitions or Kubernetes probes rather than embedded only in the Dockerfile. Choose one clear source of operational health-check configuration.

## 7.12 `CMD`

Sets the default command or default arguments used when a container starts.

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

A Dockerfile should normally have only one effective `CMD`; if multiple `CMD` instructions exist, the last one takes effect.

## 7.13 `ENTRYPOINT`

Defines the executable that the container is intended to run.

```dockerfile
ENTRYPOINT ["python", "-m", "app.cli"]
CMD ["serve"]
```

This starts as:

```text
python -m app.cli serve
```

Arguments passed after the image name replace `CMD` arguments:

```bash
docker run app-cli migrate
```

Effective command:

```text
python -m app.cli migrate
```

---

# 8. CMD vs ENTRYPOINT

Both instructions affect the command run when a container starts, but they serve different purposes.

| Instruction | Main purpose | Easily overridden by arguments after image name? |
|---|---|---:|
| `CMD` | Default command or default arguments | Yes |
| `ENTRYPOINT` | Fixed main executable | Arguments are appended; override requires `--entrypoint` |

## 8.1 CMD only

```dockerfile
CMD ["python", "app.py"]
```

Default:

```bash
docker run my-app
# Runs: python app.py
```

Override:

```bash
docker run my-app python debug.py
# Runs: python debug.py
```

## 8.2 ENTRYPOINT with CMD

```dockerfile
ENTRYPOINT ["python", "-m", "app.cli"]
CMD ["serve"]
```

Default:

```bash
docker run my-app
# Runs: python -m app.cli serve
```

Custom argument:

```bash
docker run my-app migrate
# Runs: python -m app.cli migrate
```

## 8.3 Exec form vs shell form

### Exec form

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]
```

### Shell form

```dockerfile
CMD uvicorn app.main:app --host 0.0.0.0
```

Prefer exec form for the main container process because:

- The application becomes PID 1 directly
- Unix signals are delivered more predictably
- Graceful shutdown works more reliably
- No unnecessary shell process is introduced

```mermaid
flowchart TD
    subgraph EXEC[Exec form]
        E1[PID 1] --> E2[uvicorn]
    end
    subgraph SHELL[Shell form]
        S1[PID 1] --> S2["/bin/sh"] --> S3[uvicorn]
    end
```

Some applications still require an entrypoint script for startup preparation. In that case, the script should finish with `exec "$@"` so the final application replaces the shell process.

```sh
#!/bin/sh
set -e

python -m app.migrations
exec "$@"
```

---

# 9. Docker Image Layers

Docker images are composed of ordered filesystem layers plus image configuration metadata.

Each layer represents filesystem changes such as:

- Adding files
- Modifying files
- Deleting or hiding files from lower layers
- Installing packages

Example:

```dockerfile
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Conceptual image:

```text
+-------------------------------------------------+
| Image configuration: CMD, ENV, EXPOSE, labels   |
+-------------------------------------------------+
| Layer 4: COPY app/ ./app/                       |
+-------------------------------------------------+
| Layer 3: RUN pip install ...                    |
+-------------------------------------------------+
| Layer 2: COPY requirements.txt .                |
+-------------------------------------------------+
| Layer 1: Changes related to WORKDIR/metadata    |
+-------------------------------------------------+
| Base image layers: python:3.13-slim             |
+-------------------------------------------------+
```

Not every instruction necessarily adds a large filesystem layer. Instructions such as `CMD`, `ENTRYPOINT`, `EXPOSE`, and many metadata instructions primarily update image configuration. For practical build reasoning, however, every instruction participates in the ordered build and may affect cache behavior.

## 9.1 Layers are read-only and reusable

Image layers are immutable and can be shared by multiple images and containers.

```mermaid
flowchart TD
    A["python:3.13-slim shared base layers"] --> B[orders-api image]
    A --> C[users-api image]
```

If both images use the same base layer content, Docker can store that content once and reuse it.

## 9.2 Container writable layer

When a container starts, Docker adds a writable layer above the image layers.

```text
+----------------------------------+
| Container writable layer         |
| /tmp files, generated files      |
+----------------------------------+
| Application image layer          |
+----------------------------------+
| Dependency image layer           |
+----------------------------------+
| Base image layers                |
+----------------------------------+
```

When the container modifies a file from a lower read-only layer, the storage mechanism performs copy-on-write behavior: the file is copied into the writable layer before modification.

## 9.3 Deleting a file in a later layer may not reduce image size

Consider:

```dockerfile
RUN curl -o /tmp/sdk.tar.gz https://example.invalid/sdk.tar.gz
RUN tar -xzf /tmp/sdk.tar.gz -C /opt
RUN rm /tmp/sdk.tar.gz
```

The archive was added in an earlier layer. A later layer hides/deletes it from the merged filesystem view, but the bytes can remain in the earlier layer.

Better:

```dockerfile
RUN curl -o /tmp/sdk.tar.gz https://example.invalid/sdk.tar.gz \
    && tar -xzf /tmp/sdk.tar.gz -C /opt \
    && rm /tmp/sdk.tar.gz
```

Best when possible: use a separate build stage and copy only the final artifact into the runtime stage.

---

# 10. Build Cache and Cache Invalidation

Docker BuildKit can reuse results from previous builds. Reusing unchanged layers makes repeated builds significantly faster.

```mermaid
flowchart TD
    A{Instruction and required inputs unchanged?} -->|Yes| B[Reuse cache]
    A -->|No| C[Execute instruction and evaluate following steps]
```

Suppose the Dockerfile is:

```dockerfile
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
```

If only `app/main.py` changes:

```text
FROM python:3.13-slim             CACHED
WORKDIR /app                      CACHED
COPY requirements.txt .           CACHED
RUN pip install ...               CACHED
COPY . .                          REBUILT
```

Dependencies do not need to be installed again because `requirements.txt` did not change.

## 10.1 Cache invalidation flows downward

When a step cannot use its cached result, later dependent steps are also reevaluated.

```text
Step 1  CACHED
Step 2  CHANGED
Step 3  REBUILT
Step 4  REBUILT
Step 5  REBUILT
```

This is why frequently changing files should generally be copied after stable dependency files.

## 10.2 Poor ordering

```dockerfile
FROM python:3.13-slim
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
```

Any source code change changes the `COPY . .` input and causes dependency installation to run again.

## 10.3 Better ordering

```dockerfile
FROM python:3.13-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
```

Now application source changes do not normally invalidate the dependency installation layer.

## 10.4 BuildKit cache mounts

Package-manager cache directories can be mounted as build caches without permanently storing the cache inside the final image layer.

Example for Python:

```dockerfile
# syntax=docker/dockerfile:1

FROM python:3.13-slim
WORKDIR /app

COPY requirements.txt .

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt
```

Example for Debian packages:

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends gcc
```

Cache mounts are useful in CI/CD systems where builds run repeatedly and dependency downloads are expensive.

---

# 11. Writing Cache-Friendly Dockerfiles

A good ordering principle is:

```mermaid
flowchart TD
    T[Least frequently changed] --> A[Base image]
    A --> B[System packages]
    B --> C[Dependency manifest]
    C --> D[Application dependencies]
    D --> E[Application source code]
    E --> F[Frequently changed files]
```

## 11.1 Recommended Python ordering

```dockerfile
FROM python:3.13-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 11.2 Recommended Node.js ordering

```dockerfile
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
```

## 11.3 Pin important versions

A reproducible build should avoid uncontrolled dependency changes.

```text
Base image version
Application dependencies
OS packages where practical
Build tools
```

Examples:

```dockerfile
FROM python:3.13.5-slim-bookworm
```

```text
fastapi==0.x.y
uvicorn[standard]==0.x.y
```

For stronger deployment immutability, a base image can be pinned by digest:

```dockerfile
FROM python:3.13-slim@sha256:<digest>
```

Tags are readable and convenient; digests identify exact immutable image content. Many teams use automated dependency tooling to update pinned versions and digests safely.

---

# 12. Multi-Stage Builds

A multi-stage Dockerfile contains multiple `FROM` instructions. Each `FROM` starts a separate build stage.

```dockerfile
FROM build-image AS builder
# Compile or prepare application

FROM runtime-image AS runtime
# Copy only required artifacts
COPY --from=builder /build/output /app/output
```

## 12.1 Core idea

```text
Builder stage
+-----------------------------------+
| Compiler                          |
| Development headers               |
| Build tools                       |
| Source code                       |
| Tests and temporary files         |
| Final artifact                    |
+------------------+----------------+
                   │ COPY --from=builder
                   │ only required artifact
                   ▼
Runtime stage
+-----------------------------------+
| Minimal runtime                   |
| Final artifact                    |
| Required runtime libraries        |
+-----------------------------------+
```

The final image does not need to contain compilers, source code used only for compilation, package caches, or build-time tooling.

## 12.2 Benefits

Multi-stage builds provide:

- Smaller production images
- Reduced attack surface
- Clear separation between build and runtime dependencies
- Less manual artifact copying outside Docker
- Better build reproducibility
- Separate development, testing, debugging, and production targets
- Potential parallel execution of independent stages with BuildKit

## 12.3 Naming stages

```dockerfile
FROM golang:1.25 AS builder
```

Copy from the named stage:

```dockerfile
COPY --from=builder /src/server /usr/local/bin/server
```

Names are clearer and safer than numeric stage indexes such as `--from=0`.

## 12.4 Build a specific target

```dockerfile
FROM python:3.13-slim AS base
WORKDIR /app

FROM base AS development
RUN pip install debugpy
COPY . .

FROM base AS production
COPY . .
CMD ["python", "-m", "app"]
```

Build development target:

```bash
docker build --target development -t my-app:dev .
```

Build production target:

```bash
docker build --target production -t my-app:prod .
```

## 12.5 Copy from an external image

`COPY --from` can also use another image as a source.

```dockerfile
COPY --from=busybox:latest /bin/wget /usr/local/bin/wget
```

Use this carefully so that the copied binary is compatible with the runtime image and its libraries.

---

# 13. Production FastAPI Multi-Stage Example

Python is interpreted, but multi-stage builds are still useful. A builder stage can compile wheels or install dependencies into a clean prefix, while the runtime stage excludes compilers and development headers.

## 13.1 Project structure

```text
orders-api/
├── app/
│   ├── __init__.py
│   ├── main.py
│   └── settings.py
├── requirements.txt
├── Dockerfile
└── .dockerignore
```

Example `requirements.txt`:

```text
fastapi==0.116.1
uvicorn[standard]==0.35.0
psycopg[binary]==3.2.9
```

> Pin versions according to the versions approved and tested by your project. The example numbers illustrate deterministic dependency declarations and should be updated by your dependency management process.

## 13.2 Multi-stage Dockerfile

```dockerfile
# syntax=docker/dockerfile:1

# --------------------------------------------------
# Stage 1: Build Python wheels
# --------------------------------------------------
FROM python:3.13-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

COPY requirements.txt .

RUN --mount=type=cache,target=/root/.cache/pip \
    pip wheel --wheel-dir /wheels -r requirements.txt

# --------------------------------------------------
# Stage 2: Minimal runtime image
# --------------------------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/home/appuser/.local/bin:$PATH"

WORKDIR /app

RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup --home /home/appuser appuser

COPY --from=builder /wheels /wheels
COPY requirements.txt .

RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

COPY --chown=appuser:appgroup app/ ./app/

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 13.3 What each stage does

### Builder stage

```mermaid
flowchart TD
    A["python:3.13-slim"] --> D[pip wheel]
    B[requirements.txt] --> D
    D --> E["/wheels/*.whl"]
```

### Runtime stage

```mermaid
flowchart TD
    A["python:3.13-slim"] --> E[production image]
    B[prebuilt wheels] --> E
    C[application code] --> E
    D[non-root user] --> E
```

Only the `/wheels` artifacts move from the builder to the runtime stage. The builder filesystem is not included in the final image.

## 13.4 Build and run

```bash
docker build -t orders-api:1.0.0 .
```

```bash
docker run --rm \
  --name orders-api \
  -p 8000:8000 \
  -e DATABASE_URL='postgresql://user:password@host:5432/orders' \
  orders-api:1.0.0
```

## 13.5 Verify the runtime user

```bash
docker run --rm orders-api:1.0.0 id
```

The output should show the non-root application user.

## 13.6 Inspect final image history

```bash
docker image history orders-api:1.0.0
```

This helps identify unexpectedly large layers.

---

# 14. Node.js Multi-Stage Example

Multi-stage builds are especially clear for frontend applications because the build stage needs Node.js, but the final runtime may need only static files and Nginx.

```dockerfile
# syntax=docker/dockerfile:1

# Build frontend assets
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build

# Serve compiled assets
FROM nginx:alpine AS runtime

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

Conceptual result:

```text
Builder image contains:
Node.js + npm + source + dev dependencies + build output

Final image contains:
Nginx + compiled /dist files
```

The final image does not contain:

- Node.js runtime
- npm cache
- `node_modules` development dependencies
- TypeScript source
- Build tools

---

# 15. Docker Build Context and `.dockerignore`

The build context is the set of files made available to the builder.

```bash
docker build -t orders-api:1.0.0 .
```

The final `.` means the current directory is the build context.

A Dockerfile can only directly copy files available in its build context or from explicitly defined additional contexts/stages.

## 15.1 Why build context size matters

A large context can:

- Slow local and remote builds
- Upload unnecessary files to a remote builder
- Cause unnecessary cache invalidation
- Accidentally include credentials or local artifacts
- Increase the chance of copying files that do not belong in the image

## 15.2 `.dockerignore`

Example:

```dockerignore
.git
.gitignore
.env
.env.*
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.venv/
venv/
node_modules/
dist/
build/
coverage/
*.log
Dockerfile*
docker-compose*.yml
README.md
```

Do not ignore files required by the build. For example, ignoring `requirements.txt` would break the Python example.

## 15.3 Check context transfer

Build output often displays context transfer information:

```text
=> transferring context: 42.6kB
```

An unexpectedly large value is a signal to review `.dockerignore`.

---

# 16. Image Tags, Digests, and Registries

## 16.1 Image reference format

A complete image reference can include:

```text
registry/namespace/repository:tag
```

Example:

```text
123456789012.dkr.ecr.ap-south-1.amazonaws.com/orders-api:1.4.2
```

Components:

```text
123456789012.dkr.ecr.ap-south-1.amazonaws.com  → registry
orders-api                                    → repository
1.4.2                                         → tag
```

## 16.2 Tags

A tag is a human-readable pointer such as:

```text
orders-api:1.4.2
orders-api:release-2026-07-30
orders-api:latest
```

A tag can be moved to different image content. Therefore, `latest` does not mean newest by protocol; it is simply a conventional tag name and is used as the default when no tag is specified.

Prefer immutable or traceable deployment tags:

```text
Git commit SHA
Semantic version
CI build number
Release identifier
```

Example:

```bash
docker build -t orders-api:git-a31f92c .
```

## 16.3 Digests

A digest identifies exact immutable image content.

```text
orders-api@sha256:abc123...
```

Production deployment systems may resolve a tag to a digest and deploy that exact digest for stronger reproducibility.

## 16.4 Registries

A registry stores and distributes container images.

Common registries include:

- Docker Hub
- Amazon Elastic Container Registry (Amazon ECR)
- GitHub Container Registry
- Google Artifact Registry
- Azure Container Registry

Registry workflow:

```mermaid
flowchart TD
    A[Developer or CI] -->|docker build| B["Local/build-system image"]
    B -->|docker push| C[Container registry]
    C -->|"pull by digest/tag"| D["ECS / EKS / server / local Docker"]
```

---

# 17. How Docker Layers Affect Storage

Docker stores shared image content efficiently. Containers created from the same image reuse the image's read-only layers and receive separate writable layers.

```text
Shared image layers
+----------------------------+
| Base Linux                 |
| Python runtime             |
| Application dependencies   |
| Application code           |
+----------------------------+
      │              │
      ▼              ▼
Writable A       Writable B
Container A      Container B
```

## 17.1 Copy-on-write

When a container reads an unchanged file, Docker can read it from the image layer.

When a container modifies a file from an image layer:

```mermaid
flowchart TD
    A[Read-only lower-layer file] -->|first modification| B[Copied into writable layer]
    B --> C[Modified container-specific version]
```

## 17.2 Persistent and write-heavy data

The container writable layer is suitable for ephemeral runtime data, but it is not the preferred place for durable or write-heavy application data.

Use a volume for persistent database data:

```bash
docker volume create postgres-data

docker run -d \
  --name postgres \
  -e POSTGRES_PASSWORD=secret \
  -v postgres-data:/var/lib/postgresql/data \
  postgres:17
```

The volume remains independently of the container lifecycle.

## 17.3 Current Docker Engine storage note

On fresh installations of Docker Engine 29.0 and later, the containerd image store is the default backend. It uses snapshotters for image and container data. Classic storage-driver concepts such as read-only image layers, a writable container layer, and copy-on-write remain useful for understanding behavior, although the underlying storage implementation and diagnostic commands can differ.

---

# 18. Production Best Practices

## 18.1 Use trusted, minimal base images

```dockerfile
FROM python:3.13-slim
```

A smaller image usually means:

- Less data to transfer
- Faster pull and startup preparation
- Fewer installed packages to patch
- Reduced vulnerability surface

Smallest is not always best. Alpine-based images use musl libc, which can create compatibility or build issues for some native dependencies. Choose based on application compatibility, operational support, and security maintenance.

## 18.2 Use multi-stage builds

Keep build tools out of the runtime image.

```text
Builder: compiler + source + dev tools
Runtime: executable + required libraries
```

## 18.3 Run as non-root

```dockerfile
RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser
USER appuser
```

Also consider orchestrator-level restrictions such as read-only root filesystems, dropped Linux capabilities, and seccomp profiles.

## 18.4 Keep secrets outside the image

Do not do this:

```dockerfile
ENV DATABASE_PASSWORD=my-secret-password
COPY .env /app/.env
```

Use runtime secret mechanisms:

- AWS Secrets Manager
- AWS Systems Manager Parameter Store
- ECS task definition secrets
- Kubernetes Secrets with appropriate encryption and access control
- Docker secrets where applicable
- CI/CD secret stores for build-time access

For secret-dependent build operations, use BuildKit secret mounts rather than `ARG` or `ENV`.

```dockerfile
RUN --mount=type=secret,id=pip_config \
    PIP_CONFIG_FILE=/run/secrets/pip_config \
    pip install -r requirements.txt
```

## 18.5 Keep the build context small

Use `.dockerignore` and copy only required paths.

```dockerfile
COPY requirements.txt .
COPY app/ ./app/
```

This is clearer than copying the entire repository when only two paths are required.

## 18.6 Order instructions for caching

```text
Stable dependency descriptors first
Frequently changing source code later
```

## 18.7 Avoid unnecessary packages

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
```

Install only what the runtime actually needs.

## 18.8 Use exec-form startup commands

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

This improves signal handling and graceful shutdown behavior.

## 18.9 Design containers to be disposable

A production container should be replaceable rather than manually repaired.

```mermaid
flowchart TD
    subgraph BAD[Bad operational model]
        B1["SSH/exec into container"] --> B2[Manually patch files] --> B3[Keep container forever]
    end
    subgraph GOOD[Preferred model]
        G1["Change source/config"] --> G2[Build new image] --> G3[Test] --> G4[Deploy replacement container]
    end
```

## 18.10 Send logs to stdout and stderr

Applications should normally write operational logs to standard output/error. Docker and orchestrators can collect and forward them.

```python
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info("Orders API started")
```

Avoid relying only on log files stored inside the ephemeral container layer.

## 18.11 Keep one main responsibility per container

A container normally runs one main application responsibility, such as:

```text
API container
Worker container
Scheduler container
Database container
Reverse proxy container
```

This does not mean there can only be one operating-system process. The main process may create worker processes. The important design goal is a clear lifecycle and responsibility.

## 18.12 Scan and update images

A production pipeline should include:

- Base image update automation
- Dependency vulnerability scanning
- Image scanning
- Software bill of materials where required
- Image signing/provenance where required
- Policy checks before deployment

Rebuilding the application image is necessary to receive patched base-image layers; an old running container does not update itself automatically.

## 18.13 Build for the target architecture

On Apple Silicon, the local host is typically ARM64, while some AWS runtime environments may use AMD64 or ARM64 depending on the selected instance/task architecture.

Build explicitly when needed:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t example/orders-api:1.0.0 \
  --push .
```

A multi-platform image can provide platform-specific image variants under one image reference.

---

# 19. Docker in an AWS Deployment Flow

A common AWS flow uses Amazon ECR as the image registry and Amazon ECS or Amazon EKS to run containers.

```mermaid
flowchart TD
    A[Developer pushes code] --> B[CI pipeline]
    B --> B1[Run tests]
    B --> B2[docker build]
    B --> B3[Scan image]
    B --> B4[Tag image with commit SHA]
    B --> C[Amazon ECR]
    C --> D["ECS service / EKS Deployment"]
    D --> D1[Pull image]
    D --> D2[Start containers]
    D --> D3[Apply runtime secrets]
    D --> D4[Attach IAM role]
    D --> D5[Configure networking]
    D --> D6[Send logs to CloudWatch]
```

## 19.1 Example ECR tag

```text
123456789012.dkr.ecr.ap-south-1.amazonaws.com/orders-api:a31f92c
```

## 19.2 Build and push concept

```bash
AWS_ACCOUNT_ID=123456789012
AWS_REGION=ap-south-1
REPOSITORY=orders-api
TAG=a31f92c

IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPOSITORY:$TAG"

docker build -t "$IMAGE" .
docker push "$IMAGE"
```

Authentication is normally performed using the AWS CLI and a short-lived ECR authorization token in the CI environment.

## 19.3 Runtime configuration belongs outside the image

Same image:

```text
orders-api@sha256:abc...
```

Different environments:

```text
Development → development DB URL, lower resources
Staging     → staging DB URL, test integrations
Production  → production DB URL, production secrets, autoscaling
```

This avoids rebuilding merely to change environment configuration.

## 19.4 Immutable deployment pattern

```mermaid
flowchart TD
    A[Code commit a31f92c] --> B[Image tag a31f92c]
    B --> C["Resolved image digest sha256:abc..."]
    C --> D[Deployment references that tested artifact]
```

This provides traceability from a running workload back to its source revision and build pipeline.

---

# 20. Useful Docker Commands

## 20.1 Images

```bash
# List images
docker image ls

# Build an image
docker build -t orders-api:1.0.0 .

# Build without normal cache reuse
docker build --no-cache -t orders-api:1.0.0 .

# Show image details
docker image inspect orders-api:1.0.0

# Show layer history
docker image history orders-api:1.0.0

# Remove an image
docker image rm orders-api:1.0.0

# Pull an image
docker pull python:3.13-slim

# Push an image
docker push registry.example.com/orders-api:1.0.0
```

## 20.2 Containers

```bash
# Run interactively and remove on exit
docker run --rm -it python:3.13-slim bash

# Run in background
docker run -d --name orders-api -p 8000:8000 orders-api:1.0.0

# List running containers
docker ps

# List all containers
docker ps -a

# View logs
docker logs -f orders-api

# Execute a command in a running container
docker exec -it orders-api sh

# Inspect container configuration
docker inspect orders-api

# Show container resource usage
docker stats

# Stop and remove
docker stop orders-api
docker rm orders-api
```

## 20.3 BuildKit and buildx

```bash
# Show available builders
docker buildx ls

# Inspect builder capabilities
docker buildx inspect

# Build for the current platform
docker buildx build -t orders-api:1.0.0 --load .

# Build and push multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t registry.example.com/orders-api:1.0.0 \
  --push .
```

## 20.4 Cleanup

Review before using cleanup commands in shared or important environments.

```bash
# Remove stopped containers
docker container prune

# Remove unused images
docker image prune

# Show Docker disk usage
docker system df
```

---

# 21. Practical Debugging Workflow

## 21.1 Build fails at `COPY`

Check:

```text
Is the file inside the build context?
Is it excluded by .dockerignore?
Is the path relative to the build-context root?
Is the file name case-correct?
```

Build with plain progress output:

```bash
docker build --progress=plain -t orders-api:debug .
```

## 21.2 Application starts and exits immediately

A container normally remains running only while its main process is running.

Check:

```bash
docker ps -a
docker logs <container-name>
docker inspect <container-name>
```

Run an interactive shell:

```bash
docker run --rm -it --entrypoint sh orders-api:1.0.0
```

## 21.3 Port is not reachable

Verify all three levels:

```text
1. Application listens on 0.0.0.0 inside container
2. Container uses the expected internal port
3. Host port is published with -p
```

Example:

```text
Uvicorn listens: 0.0.0.0:8000
Docker mapping:  -p 8080:8000
Browser URL:     http://localhost:8080
```

Listening only on `127.0.0.1` inside the container commonly prevents traffic arriving through the container network interface.

## 21.4 Image is unexpectedly large

Inspect history:

```bash
docker image history orders-api:1.0.0
```

Review:

- Base image choice
- Package-manager caches
- Files included by `COPY . .`
- Build tools retained in runtime
- Large artifacts added and deleted in separate layers
- Missing `.dockerignore`
- Development dependencies installed in production

Use multi-stage builds to copy only final artifacts.

## 21.5 Build cache is not being reused

Review:

- Frequently changing files copied too early
- Lockfile or dependency manifest regenerated every build
- Build arguments changing
- Timestamps or generated files changing
- Different build contexts
- Different target platforms
- CI builder cache not imported/exported

Use:

```bash
docker build --progress=plain -t orders-api:1.0.0 .
```

Look for `CACHED` lines.

## 21.6 Compare image configuration and runtime overrides

```bash
docker image inspect orders-api:1.0.0
```

```bash
docker container inspect orders-api
```

The image contains defaults; the container inspection shows the effective runtime configuration and overrides.

---

# 22. Key Takeaways

```mermaid
flowchart TD
    A[Dockerfile] -->|describes build steps| B[Image]
    B -->|"immutable, reused by many containers"| C[Container]
    C -->|"isolated process, read-only + writable layer"| D["Registry / Orchestrator<br/>distributes the same tested artifact"]
```

The most important points are:

1. A **Docker image** is an immutable package; a **container** is an instance created from that package.
2. A **Dockerfile** is the version-controlled recipe used to create the image.
3. Docker images are assembled from **reusable, ordered layers**.
4. A running container adds a **writable layer** above its read-only image layers.
5. Layer order affects **build-cache reuse**, build speed, and sometimes image size.
6. Copy dependency files before frequently changing application code to preserve cache reuse.
7. Deleting a large file in a later layer does not necessarily remove its bytes from an earlier image layer.
8. **Multi-stage builds** separate compilation/build tooling from the final runtime image.
9. Production images should use trusted bases, non-root users, external secrets, small build contexts, and explicit startup commands.
10. In AWS, build once, push the image to **Amazon ECR**, and deploy the same immutable artifact to ECS or EKS with environment-specific runtime configuration.

---

# References

Official Docker documentation used to verify the concepts in this guide:

- Docker overview: <https://docs.docker.com/get-started/docker-overview/>
- What is a container?: <https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-a-container/>
- What is an image?: <https://docs.docker.com/get-started/docker-concepts/the-basics/what-is-an-image/>
- Dockerfile overview: <https://docs.docker.com/build/concepts/dockerfile/>
- Dockerfile reference: <https://docs.docker.com/reference/dockerfile/>
- Understanding image layers: <https://docs.docker.com/get-started/docker-concepts/building-images/understanding-image-layers/>
- Docker build cache: <https://docs.docker.com/build/cache/>
- Optimize cache usage: <https://docs.docker.com/build/cache/optimize/>
- Multi-stage builds: <https://docs.docker.com/build/building/multi-stage/>
- Building best practices: <https://docs.docker.com/build/building/best-practices/>
- Storage drivers and copy-on-write concepts: <https://docs.docker.com/engine/storage/drivers/>
- containerd image store: <https://docs.docker.com/engine/storage/containerd/>
- Multi-platform builds: <https://docs.docker.com/build/building/multi-platform/>

---

**End of guide**
