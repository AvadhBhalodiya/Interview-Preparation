---
title: "CI/CD Pipelines"
group: "DevOps & Observability"
order: 5
---

# CI/CD Pipeline Concepts (Build → Test → Deploy)

> CI/CD automates the path from commit to production: continuous integration builds and tests every change on the shared branch, continuous delivery/deployment ships the artifact that passed, and the whole pipeline is built to fail fast and roll back cleanly.

## What it is
- **CI (continuous integration)** means every push builds and runs the test suite against the shared branch, so integration bugs surface in minutes instead of at one giant merge. The value isn't the YAML, it's that no branch quietly drifts for two weeks.
- **CD** is two ideas people blur. *Continuous delivery* automates the whole path but parks the last step behind a human approving prod. *Continuous deployment* drops that gate: green pipeline, straight to prod. Same machinery, different appetite for risk.

> [!KEY] CI **proves** every change on the shared branch, CD **promotes** exactly what passed. Build the artifact **once** and push that same image through staging to prod - the human gate before prod is the only line between continuous *delivery* and continuous *deployment*.

A pipeline is an ordered chain of stages, each handing its output artifact to the next, any red stage halting the rest:

| Stage | What happens | On failure |
| --- | --- | --- |
| **Source** | Push or PR triggers the run and checks out the **exact commit SHA** | Nothing to build, the run stops |
| **Build** | Compile, then build **one** image tagged with that commit SHA | A broken build blocks the merge |
| **Test** | Unit, integration, lint, and security scan against the fresh image | A red result **fails fast** and blocks everything downstream |
| **Package** | Push the immutable, SHA-tagged image to a **registry or artifact store** | No artifact means nothing to promote |
| **Deploy** | Promote the **same** image: staging -> approval gate -> prod | **Auto-rollback** to the last good release |

## Key points
- **Stages map to real tooling.** In AWS CodePipeline they are literal action types - `source`, `build`, `test`, `deploy`, plus `approval` and `invoke`. Each stage runs one execution at a time and hands artifacts to the next through an **S3 artifact store**. CodeBuild is the managed runner that usually fills build and test.
- **Build once, then promote.** The rule juniors break most. Produce one immutable image, tag it with the commit SHA, and push that same image through staging and prod. Pin the base image by digest (`FROM node:22@sha256:...`) so the build reproduces months later. Rebuild per environment and the thing you tested is no longer the thing you shipped.
- **Keep long-lived cloud keys out of CI.** Prefer OIDC so the job assumes a role for short-lived credentials, or inject from a secrets manager as masked variables. A static AWS access key in repo secrets is the textbook leak.
- **Gate prod and make rollback boring.** Require manual approval and a protected environment before prod. CodePipeline can roll a stage back to its last successful execution, and CodeDeploy can auto-roll-back when a **CloudWatch alarm** trips.

Three ways to move traffic to the new version, trading rollout speed against blast radius:

| Strategy | How traffic moves | Rollback | AWS mapping |
| --- | --- | --- | --- |
| **Rolling / in-place** | Replaces instances in **batches**, old and new versions overlap mid-deploy | Redeploy the old revision - **no spare fleet held** | CodeDeploy `OneAtATime` \| `HalfAtATime` \| `AllAtOnce`, bounded by minimum-healthy-hosts |
| **Blue-green** | Stands up a **second identical fleet**, flips **100%** once it is healthy | **Flip back** to blue - near-instant, both fleets live | ALB target-group swap, CodeDeploy blue/green |
| **Canary** | Routes a **small slice** (say 10%) first, watches metrics, then shifts the rest | Pull the slice back **before** full rollout | CodeDeploy `Canary10Percent5Minutes` or `Linear10PercentEvery1Minute` |

- **Traffic shifting lives at the load balancer.** Blue-green and canary move weight across **ALB** target groups (layer 7 routing), while a rolling replace is usually driven through an **EC2 Auto Scaling group** whose target-tracking policy holds capacity at a metric like `ASGAverageCPUUtilization`. Canary and linear differ only in shape: a canary jumps one small step then the remainder, a linear config shifts in equal repeated steps.

## Example
A minimal GitHub Actions run - build one image, test it, promote that exact image:

```yaml
# GitHub Actions: build once, test, then promote the same image
name: ci
on: [push]

jobs:
  build-test-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      # build: one immutable image, tagged with the commit SHA
      - run: docker build -t myapp:${{ github.sha }} .
      # test: a non-zero exit fails the job and blocks everything downstream
      - run: pytest -q
      # deploy: ship the exact image built above, no rebuild
      - run: ./deploy.sh myapp:${{ github.sha }}
```

The Dockerfile behind it, ordered so dependencies cache and the runtime stays slim:

```dockerfile
# Dockerfile: deps first (cached), source second, slim runtime
FROM python:3.13-slim AS build
WORKDIR /app
RUN python -m venv /venv
ENV PATH="/venv/bin:$PATH"
COPY requirements.txt .            # note: manifest before source, so this layer caches
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

FROM python:3.13-slim             # runtime stage: no build tools come along
COPY --from=build /venv /venv
COPY --from=build /app /app
ENV PATH="/venv/bin:$PATH"
WORKDIR /app
CMD ["python", "-m", "myapp"]
```

> [!TIP] Copy the manifest (`requirements.txt`, `package.json`, `go.mod`) and install **before** copying source. A code-only change then reuses the cached dependency layer instead of reinstalling the world. Add a `.dockerignore` so `.git` and `node_modules` stay out of the build context.

## Interview Q&A
- **CI vs CD?** CI builds and tests every push on the shared branch. CD takes a green build and releases it: continuous *delivery* stops at a manual approval before prod, continuous *deployment* goes all the way with no human in the loop.
- **What are the stages?** Source, build, test, package, deploy, usually with staging before prod and an approval gate between. In CodePipeline those are literal action types, and each stage passes artifacts to the next through an S3 artifact store.
- **Blue-green vs canary?** Blue-green runs two identical environments and flips 100% of traffic from old to new once new is healthy, so rollback is a flip back. Canary shifts a small slice first (say 10%), watches it, then moves the rest. AWS splits the ramp into distinct configs: a canary shifts one small step then the remainder, a linear config shifts in equal steps.
- **Why build the artifact once?** So staging and prod run the identical, already-tested bytes. Rebuild per environment and a fresh build can pull different transitive dependencies, quietly reintroducing the risk you just tested away.
- **How do you keep secrets out of the pipeline?** Don't commit them, and don't paste long-lived keys into CI. Reach for OIDC to assume a cloud role for short-lived credentials, or a secrets manager with masked variables injected at runtime.

## Gotchas
> [!WARN] If a later stage runs `docker build` again, you have silently broken "build once" and are shipping an unverified artifact - the bytes in prod were never the bytes you tested. **Promote the tagged image**, never rebuild.

> [!WARN] Long-lived cloud keys pasted into CI secrets are the classic leak. Move to **OIDC-assumed roles** for short-lived credentials, and mask anything that has to stay a variable.

- Flaky or slow tests get muted, and a muted suite is worse than none. Keep unit tests fast and deterministic. Quarantine flaky ones rather than blindly retrying.
- No rollback plan turns one bad deploy into an outage. Automate the reversal: a blue-green flip-back, or CodeDeploy auto-rollback on a CloudWatch alarm.

## Revise next
- **[Docker images & builds](docker-images-builds.md)** - multi-stage builds, layer caching, and digest pinning.
- **[Load balancing & scaling](load-balancing-auto-scaling.md)** - ALB (layer 7) vs NLB (layer 4), and EC2 Auto Scaling target-tracking behind blue-green and canary.
- **[Monitoring & logging](monitoring-logging.md)** - the CloudWatch alarms that gate automatic rollback.
- **Deployment strategies & feature flags** - decoupling release from deploy.

*Reviewed against Docker Engine 29 / Compose v2 docs (docs.docker.com) and AWS CodePipeline / CodeDeploy docs (docs.aws.amazon.com), July 2026.*
