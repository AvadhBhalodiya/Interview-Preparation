---
title: "Load Balancing & Scaling"
group: "AWS"
order: 4
---

# Load Balancing and Auto-Scaling (Basics)

> A load balancer spreads traffic across healthy targets behind one stable DNS name, while an Auto Scaling Group changes how many targets exist as load moves - one buys you availability, the other buys you elasticity, and in production you run both.

## What it is
- Two jobs people keep conflating. **Load balancing** is one stable front door that fans requests across many targets and hides the ones that are down. **Auto-scaling** is changing the *number* of targets so capacity follows demand instead of sitting over-provisioned.
- Keep them separate in your head: a load balancer over a fixed fleet still falls over in a traffic spike, and an auto-scaling fleet with no load balancer has no single address to hit. Real systems use both together.

> [!KEY] Two independent controls that meet at the target group: the **load balancer owns the front door** (one DNS name, routes only to healthy targets) and the **Auto Scaling Group owns the fleet size** (min .. desired .. max).

## Key points
- The load balancer is the single point of contact - one DNS name. It health-checks every target and routes only to the ones passing, so a sick instance is quietly pulled from rotation instead of handing a user a 502.
- Each LB has one or more **listeners** - a protocol and port such as `HTTPS:443` - whose rules forward matching traffic to a **target group**. TLS can terminate at the listener, so instances behind it speak plain HTTP. One ALB can fan host and path rules to several target groups (`/api/*` to one service, the rest to another).
- Elastic Load Balancing (ELB) offers three current types - pick by the OSI layer you need to work at:

| Type | Layer | Routes / forwards on | Health check | Best for |
| --- | --- | --- | --- | --- |
| **ALB** | **L7** HTTP/HTTPS | **host, path, header, method** - terminates TLS, does WebSockets, HTTP/2, gRPC | HTTP/HTTPS to a **path + status code** | **web-facing** apps |
| **NLB** | **L4** TCP/UDP/TLS | **flow hash**, payload untouched - static IP per AZ, preserves source IP | **TCP connect**, or an HTTP/HTTPS path | **extreme throughput**, non-HTTP, fixed IP |
| **GWLB** | **L3** IP packets | **every packet**, GENEVE-encapsulated to appliances on port 6081 | TCP or HTTP/HTTPS to the **appliance** | inline **firewalls, IDS/IPS** |

- **Classic Load Balancer (CLB)** is the previous generation. AWS says migrate off it, so keep it off anything new.
- An **Auto Scaling Group (ASG)** holds the fleet between **min / desired / max** and never steps outside those bounds. It launches instances from a launch template, spreads them across AZs, and auto-registers or deregisters them with the target group as they come and go.
- When the ASG or a rolling deploy removes an instance, the LB **deregisters it first** and holds it *draining* for a deregistration delay (300s by default) so in-flight requests finish before the box is terminated.
- **Scaling policies** decide when the desired count changes:

| Policy | How it decides capacity | Reach for it when |
| --- | --- | --- |
| **Target tracking** | holds a metric at a set value like avg CPU 60%, a **thermostat** | the **default** - most workloads |
| **Step scaling** | **tiered** steps, bigger the harder the metric breaches | you need **graduated** control on spiky load |
| **Scheduled** | changes capacity **at fixed times** (cron, UTC by default) | known **clock-driven** peaks |
| **Predictive** | **ML forecast** from history, pre-scales ahead (needs ~14 days) | repeating **daily / weekly** patterns |

> [!TIP] Start with **target tracking** - it is the thermostat that covers most services. Add **scheduled** actions for clock-driven peaks, and reach for **step scaling** only when you need different responses to how hard a metric breaches.

- **Horizontal** scaling (more instances) is the cloud default - elastic and fault-tolerant. **Vertical** scaling (a bigger instance) is simpler but capped by the largest instance type and usually needs a restart.
- ECS scales *tasks*, not instances. **Service Auto Scaling** (built on Application Auto Scaling) adjusts the desired task count behind the same ALB or NLB. On Fargate there is no EC2 instance or ASG to babysit at all.

## Example
A target-tracking policy is the whole setup for most services - name a metric, name a target, and the ASG holds the line:

```bash
# hold average CPU across the group near 60%, the ASG does the math
aws autoscaling put-scaling-policy \
  --auto-scaling-group-name web-asg \
  --policy-name cpu-60 \
  --policy-type TargetTrackingScaling \
  --target-tracking-configuration '{
    "PredefinedMetricSpecification": { "PredefinedMetricType": "ASGAverageCPUUtilization" },
    "TargetValue": 60.0
  }'
```

What the group then does on its own:
- **CPU sustained above 60%** -> raise desired count, launch and register new instances (**scale out**).
- **CPU sustained below 60%** -> lower desired count, drain and terminate instances (**scale in**).
- **An instance fails its health check** -> replace it and hold desired count steady (**self-healing**, independent of load).

Scale-out is quick, but target-tracking scale-in is deliberately gradual to protect availability and avoid flapping.

## Interview Q&A
- **ALB vs NLB - when each?** ALB is **Layer 7**: it understands HTTP, so it routes on host, path, and headers and terminates TLS. NLB is **Layer 4**: it forwards raw TCP/UDP by flow hash, does millions of requests per second at low latency, and hands you a static IP. Web app -> ALB. Raw throughput, non-HTTP, or a fixed IP to allowlist -> NLB.
- **What is GWLB for?** A Layer 3 gateway for inline security appliances - firewalls, IDS/IPS. It transparently pushes every packet through your appliance fleet using GENEVE encapsulation, then on to the destination. You use it to inspect traffic, not to serve apps.
- **What does an Auto Scaling Group actually do?** Two things, and people forget the first. It keeps desired count between min and max and replaces instances that fail health checks - that is your self-healing layer even when load is flat. Then, separately, it moves desired count up and down through scaling policies when a metric shifts.
- **Horizontal vs vertical scaling?** Horizontal adds more instances: elastic, resilient, the cloud default. Vertical swaps in a bigger box: simpler, but capped and usually with downtime.
- **How do the LB and ASG combine?** The LB owns the entry point and health-checks targets. The ASG owns how many targets exist. Launch an instance and it is auto-registered with the target group. Kill one and it is deregistered first, draining in-flight requests before it dies.

## Gotchas
> [!WARN] By default an ASG watches only **EC2 status checks** - is the VM running. It **ignores the load balancer's health check** until you turn on ELB health checks for the group. So if your app process wedges but the box stays up, the ASG happily leaves it in service. Enable ELB health checks so a failing `/health` actually triggers a replacement. This one bites mid-incident.

> [!WARN] **Scaling out only helps stateless apps.** If sessions live in an instance's local memory, every scale event logs someone out or drops their cart. Push session and state to Redis or the DB so any instance can serve any request.

- **Point the health check at a cheap `/health` route, not `/`.** If the check touches the database on every ping, a slow DB marks all targets unhealthy at once and the LB is left with nothing to route to - a self-inflicted outage.
- **Auto-scaling cannot fix a database bottleneck.** Add web instances all day and they still all hammer one primary - you have just added connections to the thing that was already the ceiling. Scale the data tier on its own terms: read replicas, caching, connection pooling.
- **Tune cooldowns and warmup or the group flaps** - launching and killing instances on every metric wobble, paying for churn and never settling. A fresh instance also needs a warmup window before it counts toward the metric, or the group over-scales chasing a number the new capacity has not affected yet.
- **Cross-zone load balancing defaults differ.** ALB always spreads across AZs and it is free. NLB has it **off by default**, so an uneven target count per AZ sends lopsided traffic - and switching it on adds cross-AZ data transfer cost. Easy to overlook until one zone runs hot.

## Revise next
- [AWS core services](aws-core-services.md)
- [Caching & sessions](../caching/redis-use-cases.md) (stateless apps)
- [Database replication & scaling](../databases/replication-sharding-partitioning.md)
- [Deployment strategies](cicd-pipelines.md): blue/green & rolling behind an LB

*Reviewed against AWS Elastic Load Balancing and EC2 Auto Scaling docs, July 2026.*
