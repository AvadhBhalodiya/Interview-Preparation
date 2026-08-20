---
title: "Docker Images & Builds"
group: "Docker"
order: 1
updated: "30 July 2026"
---

# Docker: Images, Containers, Dockerfiles, Layers & Multi-Stage Builds

> Docker packages an application into a reusable **image** and runs that image as an isolated **container**. For interviews and day-to-day backend work, the most important topics are image vs container, Dockerfile instructions, layers and cache, `CMD` vs `ENTRYPOINT`, multi-stage builds, `.dockerignore`, and production image practices.

## Index

1. Docker in One Picture
2. Image vs Container
3. Docker Build Flow
4. Dockerfile Fundamentals
5. `CMD` vs `ENTRYPOINT`
6. Image Layers and Build Cache
7. Multi-Stage Builds
8. Build Context and `.dockerignore`
9. Tags, Digests, and Registries
10. Production Best Practices
11. Practical FastAPI Example
12. Useful Commands and Debugging

---

# 1. Docker in One Picture

```mermaid
flowchart LR
    A[Source Code] --> B[Dockerfile]
    B -->|docker build| C[Docker Image]
    C -->|docker push| D[Registry]
    D -->|docker pull / deploy| E[Container]
```

The relationship is simple:

- **Dockerfile** → instructions for building an image.
- **Image** → immutable packaged application template.
- **Container** → running or stopped instance created from an image.
- **Registry** → remote storage for images, such as Docker Hub, Amazon ECR, or GHCR.

---

# 2. Image vs Container

## 2.1 Docker Image

A Docker image is a **read-only, immutable package** containing the files and configuration required to start an application.

It can contain:

- Base operating-system files
- Language runtime such as Python, Node.js, Java, or Go
- Application dependencies
- Application code or compiled binaries
- Default environment variables
- Startup command and metadata

An image does not run by itself. It mainly consumes disk storage.

## 2.2 Docker Container

A container is an isolated runtime instance created from an image.

At runtime Docker combines:

```text
+-----------------------------------+
| Writable container layer          |
| temp files / runtime changes      |
+-----------------------------------+
| Application image layer           |
+-----------------------------------+
| Dependency image layer            |
+-----------------------------------+
| Base image layers                 |
+-----------------------------------+
```

The image layers remain read-only. Runtime file changes go into the container's writable layer.

A removed container loses that writable layer unless data is stored in a volume, bind mount, database, object store, or another external persistent system.

## 2.3 Image vs Container Summary

| Aspect | Image | Container |
|---|---|---|
| Meaning | Packaged application template | Runtime instance of an image |
| State | Immutable/read-only | Has a writable runtime layer |
| CPU / memory | Does not execute | Uses runtime resources while running |
| Reuse | One image can be reused many times | Many containers can come from one image |
| Lifecycle | Built, tagged, pushed, removed | Created, started, stopped, restarted, removed |
| Example | `orders-api:1.4.2` | `orders-api-prod-1` |

**Interview focus:** the same image should be deployable to development, staging, and production. Environment-specific configuration should normally be supplied at runtime instead of rebuilding the image.

---

# 3. Docker Build Flow

A common workflow is:

```mermaid
flowchart LR
    A[Source + Dockerfile] -->|docker build| B[Image]
    B -->|docker tag / push| C[Registry]
    C -->|pull| D[Server / ECS / Kubernetes]
    D -->|start| E[Container]
```

Build an image:

```bash
docker build -t orders-api:1.0.0 .
```

Run a container:

```bash
docker run -d \
  --name orders-api \
  -p 8000:8000 \
  -e APP_ENV=production \
  orders-api:1.0.0
```

Important distinction:

```text
Build-time configuration  -> Dockerfile, ARG, BuildKit mounts
Runtime configuration     -> docker run, Compose, ECS, Kubernetes
```

Secrets should normally stay outside the image.

---

# 4. Dockerfile Fundamentals

A Dockerfile contains ordered instructions used to build an image.

```dockerfile
# syntax=docker/dockerfile:1

FROM python:3.14-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 4.1 Common Instructions

### `FROM`

Selects the base image and starts a build stage.

```dockerfile
FROM python:3.14-slim
```

Use trusted and maintained base images. Prefer a specific runtime version instead of an uncontrolled floating tag.

### `WORKDIR`

Sets the working directory for later instructions.

```dockerfile
WORKDIR /app
```

Prefer this over repeatedly writing `cd /app`.

### `COPY`

Copies files from the build context into the image.

```dockerfile
COPY requirements.txt .
COPY app/ ./app/
```

Use `COPY` for normal local file copying.

### `ADD`

Can copy files like `COPY`, but also supports additional behavior such as local tar extraction and supported remote sources.

Use `ADD` only when that extra behavior is actually required; otherwise prefer `COPY`.

### `RUN`

Runs a command **during image build**.

```dockerfile
RUN pip install --no-cache-dir -r requirements.txt
```

`RUN` is build time. `CMD` and `ENTRYPOINT` are container startup behavior.

### `ENV`

Defines an environment variable that persists in the resulting image and normally exists in containers created from it.

```dockerfile
ENV PYTHONUNBUFFERED=1
```

Do not place passwords, tokens, or private keys in `ENV`.

### `ARG`

Defines a build-time variable.

```dockerfile
ARG APP_VERSION=dev
LABEL org.opencontainers.image.version=$APP_VERSION
```

`ARG` is useful for build parameters, but it is **not a secret mechanism**. Build arguments can appear in image metadata or provenance.

### `EXPOSE`

Documents the port the application expects to use.

```dockerfile
EXPOSE 8000
```

It does **not** publish the port. Publishing is done at runtime:

```bash
docker run -p 8080:8000 orders-api:1.0.0
```

### `USER`

Sets the user for later build steps and/or the running container.

Running the application as a non-root user is preferred for production images.

---

# 5. `CMD` vs `ENTRYPOINT`

Both control container startup, but they solve different problems.

| Instruction | Purpose | Runtime behavior |
|---|---|---|
| `CMD` | Default command or default arguments | Easily replaced by arguments after the image name |
| `ENTRYPOINT` | Fixed main executable | Arguments are appended; override requires `--entrypoint` |

## 5.1 `CMD` Only

```dockerfile
CMD ["python", "app.py"]
```

```bash
docker run my-app
# python app.py

docker run my-app python debug.py
# python debug.py
```

## 5.2 `ENTRYPOINT` with `CMD`

```dockerfile
ENTRYPOINT ["python", "-m", "app.cli"]
CMD ["serve"]
```

```bash
docker run my-app
# python -m app.cli serve

docker run my-app migrate
# python -m app.cli migrate
```

## 5.3 Prefer Exec Form

Preferred:

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]
```

Avoid when not needed:

```dockerfile
CMD uvicorn app.main:app --host 0.0.0.0
```

Exec form makes the application the main container process directly, which gives cleaner Unix signal handling and more reliable graceful shutdown behavior.

---

# 6. Image Layers and Build Cache

Docker images are built from ordered immutable filesystem layers plus image configuration metadata.

Most filesystem-changing instructions such as `RUN`, `COPY`, and `ADD` contribute filesystem changes. Instructions such as `CMD`, `ENTRYPOINT`, `EXPOSE`, and labels mainly update image configuration and build history.

```text
+----------------------------------+
| Image config: CMD / ENV / labels |
+----------------------------------+
| COPY app/ ./app/                 |
+----------------------------------+
| RUN pip install ...              |
+----------------------------------+
| COPY requirements.txt .          |
+----------------------------------+
| Base image layers                |
+----------------------------------+
```

## 6.1 Cache Invalidation

Docker BuildKit tries to reuse previous build results.

For `COPY` and `ADD`, Docker checks the relevant file metadata/content inputs. For a normal `RUN`, the command itself is part of cache matching; Docker does not automatically rerun a command just because external package repositories changed.

Once a build step cannot reuse cache, later dependent steps are rebuilt as well.

### Poor Ordering

```dockerfile
COPY . .
RUN pip install -r requirements.txt
```

Any source-code change invalidates `COPY . .`, so dependency installation runs again.

### Better Ordering

```dockerfile
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
```

Now source-code changes usually keep the dependency layer cached.

## 6.2 Deleting Files in Later Layers

This does not necessarily reduce the final image size:

```dockerfile
RUN curl -o /tmp/tool.tar.gz https://example.com/tool.tar.gz
RUN tar -xzf /tmp/tool.tar.gz -C /opt
RUN rm /tmp/tool.tar.gz
```

The archive was already stored in an earlier layer.

Better:

```dockerfile
RUN curl -o /tmp/tool.tar.gz https://example.com/tool.tar.gz \
    && tar -xzf /tmp/tool.tar.gz -C /opt \
    && rm /tmp/tool.tar.gz
```

Even better for build-only artifacts: keep them in a builder stage and copy only the final output into the runtime stage.

## 6.3 BuildKit Cache Mounts

Cache mounts speed repeated dependency downloads without copying package-manager caches into the final image layer.

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pip \
    pip wheel --wheel-dir /wheels -r requirements.txt
```

This is especially useful in CI/CD.

---

# 7. Multi-Stage Builds

A multi-stage Dockerfile contains multiple `FROM` instructions. Each `FROM` starts a separate stage.

```mermaid
flowchart LR
    A[Builder Stage<br/>compiler + headers + source] -->|COPY --from=builder| B[Runtime Stage<br/>runtime + final artifact]
```

Basic pattern:

```dockerfile
FROM build-image AS builder
# build application

FROM runtime-image AS runtime
COPY --from=builder /build/output /app/output
```

The final image contains only what is copied into the runtime stage. Build tools, temporary files, source used only for compilation, and caches can remain behind.

### Main Benefits

- Smaller production image
- Reduced attack surface
- Clear build/runtime dependency separation
- Cleaner production artifact
- Easier use of separate development, test, and production targets

You can build a specific stage:

```bash
docker build --target development -t my-app:dev .
```

---

# 8. Build Context and `.dockerignore`

The final `.` in this command is the build context:

```bash
docker build -t orders-api:1.0.0 .
```

Files copied by the Dockerfile must normally be available from that context or another explicitly defined build source/stage.

A good `.dockerignore` avoids sending unnecessary files to the builder.

```dockerignore
.git
.env
.env.*
__pycache__/
*.py[cod]
.pytest_cache/
.venv/
node_modules/
dist/
build/
coverage/
*.log
```

Benefits:

- Smaller build context
- Faster local and remote builds
- Fewer accidental cache invalidations
- Lower risk of copying secrets or local artifacts

---

# 9. Tags, Digests, and Registries

An image reference commonly looks like:

```text
123456789012.dkr.ecr.ap-south-1.amazonaws.com/orders-api:1.4.2
└──────────────────── registry ───────────────────┘ └ repo ┘ └tag┘
```

## 9.1 Tags

Tags are readable pointers:

```text
orders-api:1.4.2
orders-api:git-a31f92c
orders-api:latest
```

A tag can later point to different image content. `latest` is only a conventional tag name; it does not guarantee that the image is actually the newest release.

For deployment, prefer traceable tags such as a semantic version, Git commit SHA, or CI build number.

## 9.2 Digests

A digest identifies exact immutable image content:

```text
orders-api@sha256:abc123...
```

Digests are useful when a deployment must reference the exact tested artifact.

## 9.3 Registries

Common registries include:

- Docker Hub
- Amazon ECR
- GitHub Container Registry
- Google Artifact Registry
- Azure Container Registry

---

# 10. Production Best Practices

## 10.1 Use Trusted, Minimal Base Images

Prefer official or trusted images and avoid unnecessary operating-system packages.

A slim image often reduces pull size and vulnerability surface, but the smallest image is not always the best choice. Native dependencies may require additional runtime libraries.

## 10.2 Use Multi-Stage Builds

Keep compilers, headers, test dependencies, and build tools out of the final runtime image.

## 10.3 Run as Non-Root

Create an application user and switch with `USER` before starting the application.

## 10.4 Keep Secrets Out of the Image

Do not bake credentials into `ENV`, `ARG`, copied `.env` files, or image layers.

For build-time secrets, use BuildKit secret mounts:

```dockerfile
RUN --mount=type=secret,id=pip_config \
    PIP_CONFIG_FILE=/run/secrets/pip_config \
    pip install -r requirements.txt
```

At runtime, use the secret mechanism provided by the deployment platform.

## 10.5 Keep Builds Cache-Friendly

Copy stable dependency manifests before frequently changing application source.

## 10.6 Keep Containers Disposable

Prefer:

```text
change code/config -> build new image -> test -> deploy replacement container
```

Avoid manually patching long-running containers.

## 10.7 Write Logs to stdout/stderr

Containers should normally emit application logs to standard output/error so Docker or an orchestrator can collect them.

## 10.8 Use Traceable Image Versions

Use release versions or commit-based tags. For strict reproducibility, deploy by digest.

## 10.9 Build for the Target Architecture

When development and production architectures differ, build the required platform explicitly.

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t example/orders-api:1.0.0 \
  --push .
```

## 10.10 Current Docker Storage Note

As of August 2026, Docker Engine 29 is the current major Engine line, and Docker Engine 29.7.2 was released on August 5, 2026.

For fresh Docker Engine 29+ installations, the **containerd image store** is the default backend. It uses snapshotters instead of classic storage drivers such as `overlay2`. The usual mental model of immutable image layers, a writable container layer, and copy-on-write behavior remains useful for understanding Docker images and containers.

---

# 11. Practical FastAPI Multi-Stage Example

This single example brings together the main concepts: a trusted base image, cache-friendly ordering, BuildKit cache mounts, multi-stage builds, a non-root runtime user, minimal copied files, and exec-form startup.

## 11.1 Project Structure

```text
orders-api/
├── app/
│   ├── __init__.py
│   └── main.py
├── requirements.txt
├── Dockerfile
└── .dockerignore
```

## 11.2 Dockerfile

```dockerfile
# syntax=docker/dockerfile:1

# -------------------------
# Stage 1: build wheels
# -------------------------
FROM python:3.14-slim AS builder

WORKDIR /build

COPY requirements.txt .

RUN --mount=type=cache,target=/root/.cache/pip \
    pip wheel --wheel-dir /wheels -r requirements.txt

# -------------------------
# Stage 2: runtime
# -------------------------
FROM python:3.14-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser

COPY --from=builder /wheels /wheels
COPY requirements.txt .

RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

COPY --chown=appuser:appgroup app/ ./app/

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## 11.3 What Happens During the Build

```mermaid
flowchart TD
    A[Copy requirements.txt] --> B[Build dependency wheels]
    B --> C[Start clean runtime stage]
    C --> D[Install wheels]
    D --> E[Copy application code]
    E --> F[Run as non-root user]
```

The builder can contain temporary build artifacts. Only the wheels are copied into the runtime stage, so the final image does not inherit the complete builder filesystem.

## 11.4 Build and Run

```bash
docker build -t orders-api:1.0.0 .

docker run --rm \
  --name orders-api \
  -p 8000:8000 \
  -e DATABASE_URL='postgresql://user:password@host:5432/orders' \
  orders-api:1.0.0
```

The application must listen on `0.0.0.0` inside the container so traffic arriving through Docker networking can reach it.

---

# 12. Useful Commands and Debugging

## 12.1 Images

```bash
docker image ls
docker image inspect orders-api:1.0.0
docker image history orders-api:1.0.0
docker image rm orders-api:1.0.0
```

## 12.2 Containers

```bash
docker ps
docker ps -a
docker logs -f orders-api
docker exec -it orders-api sh
docker inspect orders-api
docker stats
docker stop orders-api
docker rm orders-api
```

## 12.3 Build Debugging

Show detailed build output:

```bash
docker build --progress=plain -t orders-api:debug .
```

Build without normal cache reuse:

```bash
docker build --no-cache -t orders-api:debug .
```

Check why an image is unexpectedly large:

```bash
docker image history orders-api:1.0.0
docker system df
```

When a container exits immediately, remember that a container normally stays alive only while its main process is running:

```bash
docker ps -a
docker logs orders-api
```

When a port is unreachable, verify:

```text
Application listens on 0.0.0.0
        ↓
Correct internal container port
        ↓
Correct -p host:container mapping
```

---

# Quick Recap

```text
Dockerfile
   ↓ docker build
Image = immutable application package
   ↓ docker run
Container = isolated runtime instance + writable layer
```

Remember these interview-level points:

- Images are immutable and reusable; containers are runtime instances.
- Docker builds images in ordered steps and reuses cache when inputs match.
- Copy dependency manifests before frequently changing source code.
- Deleting data in a later layer does not remove bytes stored in an earlier layer.
- `CMD` provides defaults; `ENTRYPOINT` defines the intended executable.
- Multi-stage builds keep build tools out of production images.
- `.dockerignore` keeps the build context small and safer.
- Keep secrets outside image layers and use BuildKit secret mounts for secret-dependent builds.
- Use traceable tags or digests for deployments.
- Prefer minimal, non-root, disposable runtime containers.

---

# References

Official/current sources used to verify this note:

- Dockerfile reference: https://docs.docker.com/reference/dockerfile/
- Build cache invalidation: https://docs.docker.com/build/cache/invalidation/
- Build cache optimization: https://docs.docker.com/build/cache/optimize/
- Multi-stage builds: https://docs.docker.com/build/building/multi-stage/
- Docker build best practices: https://docs.docker.com/build/building/best-practices/
- Build variables: https://docs.docker.com/build/building/variables/
- Build secrets: https://docs.docker.com/build/building/secrets/
- containerd image store: https://docs.docker.com/engine/storage/containerd/
- Docker Engine 29 release notes: https://docs.docker.com/engine/release-notes/29/
- Python official Docker image: https://hub.docker.com/_/python
- Python 3.14.7 release: https://www.python.org/downloads/release/python-3147/
