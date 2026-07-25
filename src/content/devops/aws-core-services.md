---
title: "AWS Core Services"
group: "AWS"
order: 3
---

# AWS Core Services (EC2, S3, RDS, ECS, ECR, SQS, CloudWatch)

> A rent-don't-run toolkit of managed building blocks: compute (EC2, Lambda, containers), storage (S3, EBS), databases (RDS, DynamoDB), networking (VPC, ELB, Route 53, CloudFront), and messaging (SQS, SNS), all fenced by IAM and watched by CloudWatch.

## What it is
- The handful of managed services a Python/Django backend actually leans on in production. Each is a building block you **rent** so you never have to run it yourself.
- This is the classic rapid-fire round: one clean sentence per service, then defend the trade-off when they push.

> [!KEY] Every service here is something you **rent instead of run**. The whole game is matching a workload to the cheapest block that still gives the control you actually need.

The blocks a backend leans on most, each with the one job it does and when to grab it:

| Service | What it is | When to reach for it |
| --- | --- | --- |
| **EC2** | Virtual servers you rent by the second and patch yourself | You need **full OS control** or a long-running custom box |
| **Lambda** | Serverless functions, event-triggered, **15 min / 10 GB** ceiling | Short, spiky, **event-driven** work, no server to run |
| **ECS / Fargate** | Container orchestrator, Fargate runs tasks with **no hosts** | Docker containers without babysitting a cluster |
| **ECR** | Private Docker registry that ECS and EKS pull from | Storing your **container images** inside AWS |
| **S3** | Object storage in buckets, **11 nines** durability, HTTP GET/PUT | Files, media, backups, static assets, data lakes |
| **EBS** | Block volume attached to **one** EC2 instance in one AZ | A **disk** for a boot volume or self-managed DB |
| **RDS** | Managed relational DB with backups and Multi-AZ failover | **Relational** data, SQL joins, ACID transactions |
| **DynamoDB** | Serverless **NoSQL** key-value store, single-digit-ms reads | **Known access patterns** needing huge scale |
| **VPC** | Your isolated virtual network of subnets and route tables | Always - **everything** runs inside one |
| **ELB** | Load balancer spreading traffic across healthy targets | Fronting instances or containers with health checks |
| **Route 53** | Managed **DNS** with health checks and routing policies | Mapping domains to resources, failover routing |
| **CloudFront** | **CDN** caching content at edge locations near users | Global **low-latency** delivery of assets |
| **IAM** | Identity and access: who can call which API | Always - **every** permission in the account |
| **SQS** | Managed **pull** queue that decouples producer and consumer | Buffering work, retries, a Celery broker |
| **SNS** | **Push** pub/sub topic that fans out to many subscribers | Broadcasting one event to **many** consumers |
| **CloudWatch** | Metrics, logs, alarms, and dashboards | **Observability**, alerting, triggering auto-scaling |

## Key points
The follow-ups are almost always one service versus another. Compute is the first fork, trading control for operational load:

| Option | You manage | Best for | Billing |
| --- | --- | --- | --- |
| **EC2** | The **whole OS**, patching, scaling | Long-running, custom, full control | Per second running |
| **ECS on Fargate** | **Just the container** image | Steady containers, no cluster ops | Per vCPU + GB-second |
| **Lambda** | **Only function code** | Short (max 15 min) event bursts | Per request + ms of run |

> [!TIP] Compute decision in one breath: **Lambda** for short event bursts, **Fargate** for steady containers, **EC2** only when you truly need the box. Start managed and drop to EC2 only when control or cost forces it.

ELB ships in two flavours interviewers love to separate:

| Axis | **ALB** (Application) | **NLB** (Network) |
| --- | --- | --- |
| OSI layer | **Layer 7**, HTTP/HTTPS | **Layer 4**, TCP/UDP |
| Routes on | **Host, path, headers** | **IP and port** only |
| Reach for | Web apps, path-based microservices | **Extreme throughput**, static IP |

Queues and topics look alike but move messages in opposite directions:

| Axis | **SQS** (queue) | **SNS** (topic) |
| --- | --- | --- |
| Delivery | **Pull**, consumers poll | **Push**, fans out to subscribers |
| Consumers | **One** logical consumer drains it | **Many** subscribers, each gets a copy |
| Retention | Stores up to **14 days** | **Not stored**, delivered then gone |
| Combine them | Buffer and retry | **Fan-out**: SNS to many SQS queues |

- **RDS vs DynamoDB**: pick **RDS** when data is relational and you need joins, ACID, and ad-hoc SQL. Pick **DynamoDB** when access patterns are known up front and you want predictable single-digit-ms latency at any scale. Guessing DynamoDB's access patterns wrong is painful to undo.
- **SQS standard vs FIFO**: standard is **at-least-once** with best-effort ordering and near-infinite throughput. FIFO adds **strict ordering and exactly-once** processing but caps throughput. Default to standard with idempotent consumers unless order truly matters.
- **IAM and VPC are the invisible spine**: an IAM **role** hands short-lived permissions to a service (an EC2 instance role, an ECS task role) so you never bake keys into code. Security groups are **stateful** instance firewalls, NACLs are stateless subnet ones. A CloudWatch alarm crossing a threshold pages you via **SNS** or triggers auto-scaling.

## Example
```bash
# Build an image, authenticate to ECR, and push it so ECS/Fargate can run it.
# --password-stdin keeps the token out of shell history; Docker recommends it over -p.
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
      123456789012.dkr.ecr.us-east-1.amazonaws.com

docker build -t myapp:latest .
docker tag  myapp:latest 123456789012.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/myapp:latest
# note: that login token is valid ~12h, so CI re-runs the login on every build.

aws s3 cp report.csv s3://my-bucket/reports/   # object storage: whole-file PUT, no appends
```

## Interview Q&A
- **EC2 vs ECS/Fargate vs Lambda?** EC2 is a raw VM you own end to end. ECS schedules your containers, and Fargate runs them with no hosts. Lambda runs a function with no server and a 15-minute ceiling. Same code, rungs of how much you babysit.
- **Why S3 instead of the EC2 disk?** Instance disk dies with the instance and can't be shared. S3 is durable to 11 nines, effectively infinite, and reachable over HTTP by every instance at once. Local disk is scratch space.
- **SQS or SNS?** SQS is a pull queue for one consumer buffering work. SNS is push pub/sub fanning one event to many. Chain SNS to several SQS queues when you want both.
- **What does RDS Multi-AZ actually buy you?** Automatic failover to a standby in another AZ, which is availability, not read scaling. The standby serves no reads. That is what read replicas are for.
- **RDS or DynamoDB?** RDS for relational data, joins, and ACID. DynamoDB for known access patterns needing single-digit-ms latency at scale. Unsure of your queries means reach for RDS.

## Gotchas
> [!WARN] The RDS Multi-AZ standby is invisible - it does **not** serve reads. It only exists to fail over when the primary dies. Read scaling is a **separate** feature, read replicas. Claiming Multi-AZ scales reads is the classic wrong answer.

> [!WARN] SQS standard is **at-least-once**, so the same message can arrive **twice**. The usual cause is a consumer that runs longer than the **visibility timeout**, so the message reappears and a second worker grabs it. Make every handler idempotent by deduping on a key.

- S3 is not a filesystem. No appends, no in-place edits, no seeking, you replace the whole object. Treat a bucket as a key-value store of blobs, not a mounted disk.
- Over-broad IAM policies and public S3 buckets are the top way accounts get owned. Default to least privilege, keep Block Public Access on, and scope each role to the one resource it needs.
- Fargate removes server ops but charges a premium per vCPU and GB-second. At steady high load, EC2-backed ECS is cheaper, so don't reach for Fargate on reflex.
- Lambda hard-caps at 15 minutes and 10 GB of memory. Long or heavy jobs belong on a container or EC2, or split across steps with Step Functions.

## Revise next
- **[Load balancing and auto-scaling](load-balancing-auto-scaling.md)**: ALB target groups, plus an Auto Scaling **target-tracking** policy that holds a CloudWatch metric (say average CPU at 50%) by adding or removing instances.
- **[CI/CD deploy strategies](cicd-pipelines.md)**: rolling, blue/green, and canary, with CodeDeploy or ECS-native rollout doing automatic rollback on a CloudWatch alarm.
- **[Docker images and multi-stage builds](docker-images-builds.md)** (what feeds ECR and ECS), plus CloudWatch Logs Insights for querying logs after the fact.

*Reviewed against AWS docs and docs.docker.com (Engine 29), July 2026.*
