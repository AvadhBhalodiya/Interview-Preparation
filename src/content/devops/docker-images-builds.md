---
title: "Docker Images & Builds"
group: "Docker"
order: 1
---

# Docker: Image vs Container, Dockerfile, Layers, Multi-Stage

> An image is a read-only stack of layers built from a Dockerfile. A container is one running instance of that image with a thin writable layer on top, and multi-stage builds are how you keep the shipped image small.

## What it is
- **Image**: a read-only, layered template - a frozen filesystem snapshot plus metadata (default command, env vars, exposed ports, working dir). Because it is immutable, the same image ID runs identically on your laptop and in prod.
- **Container**: a running or stopped instance of an image. Docker stacks one thin **writable layer** on top, and everything the process writes at runtime lands there. Delete the container and that layer goes with it.

> [!KEY] An **image** is a shared, read-only stack of layers. A **container** is that image plus one private writable layer, so ten containers off one image share the layers on disk (copy-on-write) and differ only in what they write.

Image and container are the same bytes at two life stages - build output versus running process:

| Aspect | **Image** | **Container** |
| --- | --- | --- |
| State | **read-only**, immutable | **writable** layer over the image |
| Created by | `docker build` | `docker run` |
| Count | **one** definition | **many** instances |
| Persistence | layers **kept** on disk | writable layer **dies** with it |
| Analogy | class / **template** | **instance** / process |

## Key points
- The **Dockerfile** is the build recipe. Each instruction (`FROM`, `RUN`, `COPY`, `ENV`, `EXPOSE`, `CMD`/`ENTRYPOINT`) becomes one layer, and the cache keys off the instruction text plus, for `COPY`/`ADD`, the contents of the files it pulls in.
- **Layer order is your biggest lever on build speed.** Docker checks the cache top-down, and the first changed layer forces every layer beneath it to rebuild. Install dependencies before copying source - get it backwards and a one-character code edit reinstalls the whole dependency tree:

| # | Instruction | Changes | Cache behavior |
| --- | --- | --- | --- |
| 1 | `FROM python:3.13-slim` | almost never | base, **stays cached** |
| 2 | `COPY requirements.txt .` | rarely | busts **only** when deps change |
| 3 | `RUN pip install -r ...` | rarely | the **slow** step, keep it high |
| 4 | `COPY . .` | **every commit** | put **last** so edits skip the deps layer |
| 5 | `CMD ["gunicorn", ...]` | rarely | metadata only, **no** rebuild cost |

- **Multi-stage builds** use several `FROM` lines, each a fresh stage on its own base. Compile or install in an early stage, then `COPY --from=build` only the finished artifacts into a lean final stage. Toolchains, dev headers, and any build-time secret stay behind and never ship. `docker build --target build` stops at a named stage for debugging.
- **`.dockerignore`** trims the build context before it is uploaded to the daemon. It is a newline-separated list of globs (`.git`, `node_modules`, `__pycache__`, `.env`). It keeps junk out of `COPY . .`, shrinks the context, and stops secrets from landing in a layer. One catch: an exclusion applies to **every** stage of a multi-stage build.
- **BuildKit** has been the default builder since Engine 23.0 (Feb 2023). It runs independent stages in parallel, skips stages your target does not need, re-sends only changed context files, and adds cache mounts (`--mount=type=cache`) and build secrets (`--mount=type=secret`) so credentials never bake into a layer.
- **Engine 29 (2026)** makes the **containerd image store** the default on new installs, retiring the legacy graph drivers. It shares one content store with container execution and can hold native multi-platform images. Existing installs are not force-migrated.

> [!TIP] Sane defaults to memorize: slim or alpine base, pin the version (pin the **digest** when a build must be reproducible), one concern per container, drop to a non-root `USER`, and a `.dockerignore` from day one.

## Example
```dockerfile
# multi-stage: install deps in a throwaway build stage, ship only the result
FROM python:3.13-slim AS build
WORKDIR /app
COPY requirements.txt .
# --prefix collects everything under /install so the runtime stage copies it in one shot
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.13-slim
WORKDIR /app
COPY --from=build /install /usr/local   # just the installed packages, no pip, no build tools
COPY . .
USER nobody                             # good: run unprivileged
EXPOSE 8000
CMD ["gunicorn", "app:app", "-b", "0.0.0.0:8000"]
```

```bash
# build once locally, then push to Amazon ECR (the login token is good for 12h)
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com
docker tag myapp:latest <acct>.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
docker push <acct>.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
```

## Interview Q&A
- **Image vs container?** An image is the read-only, layered template. A container is a running instance of it with a writable layer on top. One image, many containers.
- **Why does Dockerfile order matter?** The cache invalidates top-down, so put slow, stable steps (dependency installs) above fast-changing ones (your code). Everyday edits then hit the cache instead of reinstalling dependencies.
- **What do multi-stage builds buy you?** A small, clean runtime image. Build with the full toolchain in one stage, copy only the artifacts forward, and compilers plus build-time secrets never reach production.
- **What does `.dockerignore` do?** It excludes files from the build context before upload, so `.git`, local `.env` files, and `node_modules` never enter a layer or leak through `docker history`. It also speeds up the context send.
- **How would you shrink an image?** Slim or alpine base, multi-stage to drop build tools, `--no-cache-dir` on pip, chain related `RUN` steps, and a `.dockerignore` so junk never enters the context.

## Gotchas
> [!WARN] **Copy `requirements.txt`/`package.json` and install before `COPY . .`.** Copy source first and every commit busts the dependency layer, so each build reinstalls the whole tree. This is the single most common cause of slow builds.

> [!WARN] **Never `COPY . .` without a `.dockerignore`.** Otherwise `.git`, `.env`, and credentials bake into a layer anyone can extract with `docker history` or by unpacking the image.

- Whatever a container writes lives in its disposable writable layer and vanishes when it is removed. Persist real data with a **volume** or bind mount.
- Splitting `RUN apt-get update` from `apt-get install` lets the update get cached while installs later pull stale versions. Keep them in one `RUN ... && ...`.
- Root plus a fat base image is needless attack surface. Use a slim base and a non-root `USER`.
- A moving tag like `python:3.13-slim` can change under you between builds. Pin a specific version, or the digest, when you need the same output twice.

## Revise next
- [Docker Compose and container networking](docker-compose-networking.md)
- [AWS ECR then ECS/Fargate](aws-core-services.md) (store the image, then run it)
- [CI/CD image builds](cicd-pipelines.md) (BuildKit cache export, GitHub Actions)

*Reviewed against Docker Engine 29 / Compose v2, July 2026.*
