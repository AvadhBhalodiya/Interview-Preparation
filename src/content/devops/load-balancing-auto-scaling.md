---
title: "Load Balancing & Scaling"
group: "AWS"
order: 4
updated: "July 2026"
---

# Load Balancing and Auto Scaling — Basics

> Build a practical understanding of how production applications distribute traffic, remain available, and adjust capacity as demand changes.

## In short

- **Vertical scaling** grows one machine (e.g. `t3.medium` → `m7i.2xlarge`); **horizontal scaling** adds more machines. Most cloud-native apps scale horizontally — it also improves fault tolerance, not just capacity.
- **Layer 4** load balancers (NLB) route on IP, port, and protocol only; **Layer 7** load balancers (ALB) read HTTP details — host, path, headers, cookies — to route intelligently. Use ALB for web/API traffic, NLB for raw TCP/UDP/TLS throughput.
- **Health checks** are what turn a load balancer into more than a round-robin dispatcher: they pull unhealthy targets out of rotation automatically and only return them once checks pass again.
- An Auto Scaling Group runs on three numbers — **minimum**, **desired**, **maximum** capacity. Scaling policies only ever move *desired* between the other two.
- The load balancer decides **which** healthy target gets each request; auto scaling decides **how many** targets exist. Neither does the other's job — they meet at the target group.
- By default an ASG only reacts to EC2-level status checks, not application health — enabling **ELB health checks** on the group is what lets it replace an instance whose app has hung.
- Start scaling policies with **target tracking** (a thermostat around one metric, e.g. 50% CPU); add scheduled or predictive scaling for known patterns, and always scale in more conservatively than you scale out.

```mermaid
flowchart TB
    USERS[Users] --> ALB[Application Load Balancer]

    ALB --> TG[Target Group]

    subgraph ASG[EC2 Auto Scaling Group]
        direction LR
        EC21[EC2 Instance 1]
        EC22[EC2 Instance 2]
        EC23[EC2 Instance 3]
    end

    TG --> EC21
    TG --> EC22
    TG --> EC23

    CW[CloudWatch Metrics] --> POLICY[Scaling Policy]
    POLICY --> ASG

    LT[Launch Template] --> ASG
```

**Interview answer:** A load balancer accepts traffic at one endpoint and forwards each request to a healthy target, using health checks to keep that pool accurate; auto scaling watches metrics like CloudWatch CPU or request count and changes how many targets exist by moving desired capacity between a minimum and maximum. They meet at the target group — the load balancer never launches instances, and the ASG never chooses which instance serves a given request — so the fleet grows and shrinks with demand while the entry point stays constant.

**Gotcha:** Assuming a failed health check always gets the instance replaced. By default an ASG only reacts to EC2 status-check failures — unless ELB health checks are explicitly enabled on the group, an application that hangs but keeps the OS alive is simply pulled from rotation forever, never terminated or replaced.

---

# 1. The Big Picture

## 1.1 Why Applications Need Scaling

A single server has limited CPU, memory, network bandwidth, disk throughput, maximum connections, and availability. When traffic increases, one server may become slow or unavailable, so a production system usually runs multiple application instances behind a load balancer instead.

```mermaid
flowchart LR
    U[Users] --> S["One Server (without scaling)"]
    S --> L1[Limited capacity]
    S --> L2[Single point of failure]
    S --> L3[Maintenance causes downtime]
```

```mermaid
flowchart LR
    U[Users] --> LB["Load Balancer (with auto-scaling)"]
    LB --> A1[Application Instance 1]
    LB --> A2[Application Instance 2]
    LB --> A3[Application Instance 3]
    LB --> A4[New instances when required]
```

---

## 1.2 Vertical Scaling vs Horizontal Scaling

**Vertical scaling** increases the capacity of one machine — for example, changing an EC2 instance from `t3.medium` to `m7i.2xlarge`, or adding CPU and memory to a database or VM. **Horizontal scaling** adds more machines or containers — for example, going from 1 instance to 4.

### Comparison

| Area | Vertical Scaling | Horizontal Scaling |
|---|---|---|
| Main action | Increase machine size | Add more machines |
| Downtime risk | May require restart | Usually supports gradual scaling |
| Maximum capacity | Limited by largest machine | Can grow across many instances |
| Application requirement | Can support stateful apps more easily | Works best with stateless apps |
| Fault tolerance | Still one machine unless replicated | Multiple instances improve availability |
| Cloud-native suitability | Moderate | High |

Most web applications use **horizontal scaling** for the application layer.

---

## 1.3 Scalability vs Availability vs Elasticity

These terms are related but not identical. **Scalability** is the system's ability to handle more load by adding resources. **Availability** is whether the system stays accessible even when some components fail. **Elasticity** is the system automatically adding and removing resources as demand changes.

```mermaid
flowchart LR
    LB[Load Balancer] --> LB1[Improves traffic distribution and availability]
    AS[Auto Scaling] --> AS1[Improves elasticity and capacity management]
    AZ[Multiple AZs] --> AZ1[Improves fault tolerance]
    MON[Monitoring] --> MON1[Provides signals for scaling and recovery]
```

---

# 2. Load Balancing Fundamentals

## 2.1 What Is a Load Balancer?

A load balancer is a component that receives client traffic and distributes it across multiple backend targets — virtual machines, EC2 instances, Docker containers, ECS tasks, Kubernetes pods, IP addresses, or (in supported AWS configurations) Lambda functions.

The client communicates with one public endpoint, while the load balancer decides which healthy backend should process each request.

---

## 2.2 Main Responsibilities

A load balancer commonly performs the following work:

1. Accept client connections.
2. Select a backend target.
3. Forward the request.
4. Check target health.
5. Stop sending traffic to unhealthy targets.
6. Resume traffic when a target becomes healthy.
7. Terminate TLS/SSL when configured.
8. Apply routing rules.
9. Collect traffic and performance metrics.

---

## 2.3 Basic Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant DNS as DNS
    participant LB as Load Balancer
    participant A as App Instance A
    participant B as App Instance B

    U->>DNS: Resolve application domain
    DNS-->>U: Return load balancer endpoint
    U->>LB: HTTPS request
    LB->>LB: Evaluate listener and routing rules
    LB->>A: Forward request to healthy target
    A-->>LB: Application response
    LB-->>U: HTTPS response
```

---

## 2.4 Layer 4 vs Layer 7 Load Balancing

The Open Systems Interconnection model is commonly used to describe the level at which a load balancer operates.

### Layer 4 — Transport Layer

Layer 4 routing uses connection information only — source IP, destination IP, TCP or UDP port, and protocol — without needing to understand the HTTP URL or headers.

Typical use cases:

- TCP applications
- UDP workloads
- Very high-throughput services
- Low-latency network traffic
- TLS passthrough
- Gaming and streaming protocols

### Layer 7 — Application Layer

Layer 7 routing understands application-level details — HTTP method, host name, URL path, headers, query parameters, cookies.

Typical use cases:

- Web applications
- REST APIs
- Microservices
- Host-based routing
- Path-based routing
- Authentication integrations

### Comparison

| Area | Layer 4 | Layer 7 |
|---|---|---|
| Main information | IP, port and protocol | HTTP request details |
| Routing intelligence | Lower | Higher |
| HTTP path routing | No | Yes |
| Protocol examples | TCP, UDP, TLS | HTTP, HTTPS, gRPC |
| Typical AWS service | Network Load Balancer | Application Load Balancer |
| Performance overhead | Lower | Slightly higher due to request inspection |

---

## 2.5 Common Load-Balancing Algorithms

These are general industry algorithms. Managed cloud load balancers may choose or optimize their internal distribution behavior differently.

### Round Robin

Requests are distributed sequentially.

```mermaid
flowchart LR
    R1[Request 1] --> A[Server A]
    R2[Request 2] --> B[Server B]
    R3[Request 3] --> C[Server C]
    R4[Request 4] --> A
```

Suitable when backend servers have similar capacity and requests require similar work.

### Least Connections

Traffic is sent to the server with the fewest active connections. Suitable when request duration varies significantly.

### Weighted Distribution

More traffic is sent to servers with higher assigned weights (for example, `Server A: weight 70` vs `Server B: weight 30`). Useful during:

- Canary releases
- Blue/green deployments
- Gradual migration
- Mixed-capacity infrastructure

### Hash-Based Routing

A value such as client IP or session identifier is hashed to select a target, so the same client generally reaches the same backend.

---

## 2.6 Health Checks

The load balancer periodically sends a request to each registered target and expects a healthy response:

```http
GET /health HTTP/1.1
Host: app.internal

HTTP/1.1 200 OK
Content-Type: application/json

{"status": "healthy"}
```

The load balancer uses configurable values such as:

- Health-check protocol
- Health-check port
- Health-check path
- Check interval
- Timeout
- Healthy threshold
- Unhealthy threshold
- Expected status-code range

A failed health check should remove the target from traffic rotation, not necessarily destroy it immediately.

---

## 2.7 Sticky Sessions

Sticky sessions, also called **session affinity**, try to route a user back to the same backend target for a period of time (`User A → Server 1 → Server 1 → ...`), which helps legacy applications that keep session state in process memory.

However, they create challenges:

- Uneven traffic distribution
- Session loss when a target fails
- Difficult deployments
- Reduced scaling flexibility

A more scalable design stores shared session state in Redis, a database, a signed client-side cookie, or an external session service, keeping the application instances themselves stateless.

---

## 2.8 TLS Termination

A load balancer can terminate HTTPS traffic — client to load balancer over HTTPS, then load balancer to application over HTTP or HTTPS — which centralizes certificate management, reduces cryptographic work on application instances, keeps TLS policy consistent, integrates with AWS Certificate Manager, and simplifies certificate rotation.

For sensitive production systems, traffic from the load balancer to the target can also use HTTPS.

---

# 3. AWS Elastic Load Balancing

AWS Elastic Load Balancing distributes incoming traffic across healthy targets in one or more Availability Zones. The managed load balancer adjusts its own capacity as traffic changes. The surrounding AWS services these targets run on are introduced in [AWS Core Services](aws-core-services.md).

AWS provides these current load-balancer families:

- Application Load Balancer
- Network Load Balancer
- Gateway Load Balancer
- Classic Load Balancer for legacy workloads

---

## 3.1 Core AWS Components

| Component | Role |
|---|---|
| Load Balancer | The managed entry point that accepts traffic |
| Listener | Checks for incoming connections on a configured protocol and port (for example HTTP:80, HTTPS:443, TCP:5432, TLS:443) |
| Listener Rule | Determines where traffic should be forwarded — e.g. `IF path starts with /api/ THEN forward to API target group` |
| Target Group | A logical collection of backend targets: EC2 instances, IP addresses, ECS tasks, Lambda functions for supported ALB use cases, or another ALB as an NLB target |
| Target | The actual backend application endpoint |
| Health Check | The mechanism used to determine whether a target can receive traffic |

---

## 3.2 Component Diagram

```mermaid
flowchart LR
    U[Users] --> DNS[Route 53 / DNS]
    DNS --> ALB[Application Load Balancer]

    ALB -->|Listener :443| R{Listener Rules}
    R -->|/api/*| TG1[API Target Group]
    R -->|/admin/*| TG2[Admin Target Group]
    R -->|Default| TG3[Web Target Group]

    TG1 --> A1[API Instance 1]
    TG1 --> A2[API Instance 2]

    TG2 --> B1[Admin Instance]

    TG3 --> C1[Web Instance 1]
    TG3 --> C2[Web Instance 2]
```

---

## 3.3 Application Load Balancer

An Application Load Balancer, or ALB, is designed mainly for HTTP and HTTPS workloads.

### Important Capabilities

- Layer 7 routing
- Host-based routing
- Path-based routing
- Header and query-string conditions
- HTTP-to-HTTPS redirects
- WebSocket support
- HTTP/2 support
- gRPC support
- TLS termination
- Target groups
- Integration with AWS WAF
- Authentication integration for supported identity providers
- Weighted forwarding between target groups

### Path-Based Routing Example

```mermaid
flowchart LR
    P1["/api/*"] --> S1[API service]
    P2["/images/*"] --> S2[Image service]
    P3["/admin/*"] --> S3[Admin service]
    P4["/*"] --> S4[Frontend service]
```

### Host-Based Routing Example

```mermaid
flowchart LR
    H1[api.example.com] --> T1[API target group]
    H2[admin.example.com] --> T2[Admin target group]
    H3[shop.example.com] --> T3[Store target group]
```

### Suitable Workloads

- Websites
- REST APIs
- Django, FastAPI, Node.js and Java web applications
- ECS services
- Kubernetes ingress through an AWS integration
- Microservice applications

---

## 3.4 Network Load Balancer

A Network Load Balancer, or NLB, operates mainly at Layer 4.

### Important Capabilities

- TCP traffic
- UDP traffic
- TLS traffic
- Very high connection volume
- Low-latency routing
- Static IP support
- Elastic IP support for internet-facing configurations
- Preserving source IP in supported configurations
- AWS PrivateLink integration

### Suitable Workloads

- Non-HTTP protocols
- Real-time communication
- High-throughput TCP services
- Applications that require static IP addresses
- PrivateLink endpoint services
- TLS passthrough requirements

---

## 3.5 Gateway Load Balancer

A Gateway Load Balancer, or GWLB, is used to deploy and scale virtual network appliances.

Typical appliances include:

- Firewalls
- Intrusion detection systems
- Intrusion prevention systems
- Deep packet inspection appliances
- Network monitoring appliances

It is not normally used as the public HTTP entry point for a web application.

---

## 3.6 Classic Load Balancer

Classic Load Balancer is the previous-generation AWS load balancer. For new applications, prefer ALB, NLB or GWLB as appropriate (see the selection guide below); use Classic Load Balancer mainly when maintaining a legacy architecture that specifically depends on it.

---

## 3.7 AWS Load Balancer Selection

| Requirement | Recommended Choice |
|---|---|
| HTTP or HTTPS web application | ALB |
| REST API with path routing | ALB |
| Multiple microservices behind one endpoint | ALB |
| gRPC service | ALB |
| TCP or UDP application | NLB |
| Static public IP requirement | NLB |
| Extremely high connection throughput | NLB |
| AWS PrivateLink provider service | NLB |
| Firewall or packet-inspection fleet | GWLB |
| Existing legacy integration | Possibly Classic Load Balancer |

---

## 3.8 Internet-Facing vs Internal Load Balancer

An **internet-facing** load balancer receives requests from clients over the internet (Internet → Public Load Balancer → Private Application Instances), so the application targets themselves do not need public IP addresses. An **internal** load balancer receives traffic only through private networking (Frontend Service → Internal Load Balancer → Backend Service) — typical uses include internal APIs, service-to-service communication, administrative applications, and private enterprise systems.

---

## 3.9 Multi-AZ Deployment

A highly available load balancer should use subnets in at least two Availability Zones, so that if one target or Availability Zone has a problem, healthy capacity in another zone can continue processing requests.

---

# 4. Auto-Scaling Fundamentals

## 4.1 What Is Auto-Scaling?

Auto-scaling automatically adjusts compute capacity according to workload demand or a predefined schedule.

```mermaid
flowchart LR
    LT[Low traffic] --> RC[Remove unnecessary capacity]
    HT[High traffic] --> AC[Add capacity]
    F[Failure] --> RUC[Replace unhealthy capacity]
```

Auto-scaling has two major goals:

1. Maintain enough capacity to serve users reliably.
2. Avoid paying for unnecessary idle capacity.

---

## 4.2 Scale Out and Scale In

**Scale out** adds more instances or containers (2 instances → 4 instances). Scale out when:

- CPU is consistently high
- Requests per target increase
- Queue length grows
- Latency rises due to capacity pressure
- A predictable traffic event is approaching

**Scale in** removes instances or containers (4 instances → 2 instances). Scale in when:

- Traffic decreases
- Utilization remains below the target
- Scheduled peak time ends
- Extra capacity is no longer required

Scale-in decisions should be more conservative than scale-out decisions because removing capacity too quickly can create instability.

---

## 4.3 Reactive vs Proactive Scaling

**Reactive scaling** changes capacity after a metric shows demand has changed (`Average CPU > 65% → add instances`). **Proactive scaling** adds capacity before expected demand arrives (`Every weekday at 8:45 AM → increase desired capacity to 10`). Predictive scaling also uses historical patterns to forecast future capacity requirements.

---

## 4.4 Desired Capacity Model

Most auto-scaling systems use three important limits.

```text
Minimum Capacity ≤ Desired Capacity ≤ Maximum Capacity
```

Example:

| Setting | Value | Meaning |
|---|---:|---|
| Minimum | 2 | Never run fewer than two instances |
| Desired | 4 | Current intended number of instances |
| Maximum | 12 | Never scale beyond twelve instances |

The desired value changes as scaling policies run.

---

# 5. Amazon EC2 Auto Scaling

## 5.1 What Is an Auto Scaling Group?

An Auto Scaling Group, or ASG, manages a group of EC2 instances as one logical capacity pool.

An ASG can:

- Launch instances
- Terminate instances
- Maintain minimum capacity
- Replace unhealthy instances
- Scale according to CloudWatch metrics
- Scale according to a schedule
- Distribute instances across Availability Zones
- Register instances with load-balancer target groups

---

## 5.2 Main Components

### Launch Template

Defines how new EC2 instances should be created.

A launch template commonly includes:

- AMI
- Instance type
- Security groups
- IAM instance profile
- Storage
- SSH key, when required
- User data
- Network configuration
- Instance tags
- Purchase options

### Auto Scaling Group

Defines:

- Minimum capacity
- Desired capacity
- Maximum capacity
- Availability Zones or subnets
- Target groups
- Health-check settings
- Scaling policies
- Instance maintenance behavior
- Termination policies

**Scaling Policy** defines when and how desired capacity should change. **CloudWatch Metric** provides the data used for scaling decisions.

---

## 5.3 Instance Lifecycle

A simplified instance lifecycle is:

```mermaid
flowchart TD
    L[Launch] --> P[Pending]
    P --> IS[InService]
    IS --> SI[Scale-in selected]
    IS --> HF[Health check failure]
    IS --> MT[Manual termination]
    SI --> T[Terminating]
    HF --> T
    MT --> T
    T --> TE[Terminated]
```

Lifecycle hooks can pause selected transitions so that custom work can run — for example, installing or warming application data before serving traffic, downloading configuration, registering with an external monitoring system, finishing in-progress work before termination, or uploading final logs.

---

## 5.4 Health-Check Types

**EC2 Health Check** detects infrastructure-level problems reported by EC2, such as host failure, instance failure, or a system status-check failure.

**Elastic Load Balancing Health Check** detects whether the application target is healthy from the load balancer's perspective — for example, the application process stopped, the health endpoint returns `500`, the application port stops accepting traffic, or a dependency check fails.

For an ASG behind a load balancer, enabling load-balancer health checks allows unhealthy application instances to be replaced, not merely removed from traffic.

---

## 5.5 Automatic Replacement

Suppose the desired capacity is three and all three instances are running healthy. One instance becomes unhealthy (`Running healthy: 2, Unhealthy: 1`); the ASG can terminate it and launch a replacement, bringing the group back to three running healthy instances. This is self-healing behavior, even when no traffic-based scale-out is required.

---

# 6. Load Balancer and Auto Scaling Together

## 6.1 Different Responsibilities

| Component | Primary Responsibility |
|---|---|
| Load Balancer | Distribute incoming traffic |
| Target Group | Maintain the set of traffic destinations |
| Health Check | Decide which targets can receive traffic |
| Auto Scaling Group | Maintain and adjust EC2 capacity |
| Scaling Policy | Decide when capacity should change |
| CloudWatch | Collect metrics and trigger scaling logic |

A load balancer does not normally launch EC2 instances.

An Auto Scaling Group does not decide which individual request should go to which instance.

They work together.

---

## 6.2 Scale-Out Flow

```mermaid
sequenceDiagram
    participant U as Users
    participant ALB as Load Balancer
    participant CW as CloudWatch
    participant ASG as Auto Scaling Group
    participant EC2 as New EC2 Instance

    U->>ALB: Increased traffic
    ALB->>CW: Request and utilization metrics
    CW->>ASG: Scaling policy condition requires capacity
    ASG->>EC2: Launch instance using launch template
    EC2->>EC2: Boot and start application
    ASG->>ALB: Register target
    ALB->>EC2: Perform health checks
    EC2-->>ALB: Healthy response
    ALB->>EC2: Start forwarding user requests
```

---

## 6.3 Scale-In Flow

```mermaid
flowchart TD
    S1[Workload decreases] --> S2[Scaling policy reduces desired capacity]
    S2 --> S3[ASG selects an instance for termination]
    S3 --> S4[Target is deregistered from the target group]
    S4 --> S5[Load balancer stops sending new requests to that target]
    S5 --> S6[Existing requests are allowed to finish during the configured drain period]
    S6 --> S7[Instance shuts down and is terminated]
```

This graceful process helps avoid dropping active requests.

---

## 6.4 Dynamic Registration

When the ASG launches an instance:

1. The instance starts from the launch template.
2. The application starts.
3. The ASG registers the instance with the target group.
4. The load balancer performs health checks.
5. Only after the target becomes healthy does it receive traffic.

When an instance is terminated, it is deregistered automatically.

---

# 7. Practical AWS Architecture

## 7.1 Typical Highly Available Web Application

```mermaid
flowchart TB
    INTERNET[Internet Users] --> R53[Route 53]
    R53 --> WAF[AWS WAF - Optional]
    WAF --> ALB[Public Application Load Balancer]

    subgraph VPC[VPC]
        subgraph PUBLIC[Public Subnets]
            ALB
        end

        subgraph PRIVATE_A[Private Subnet - AZ A]
            APP1[EC2 App Instance]
            APP2[EC2 App Instance]
        end

        subgraph PRIVATE_B[Private Subnet - AZ B]
            APP3[EC2 App Instance]
            APP4[EC2 App Instance]
        end

        REDIS[(ElastiCache / Redis)]
        DB[(Multi-AZ Database)]
    end

    ALB --> APP1
    ALB --> APP2
    ALB --> APP3
    ALB --> APP4

    APP1 --> REDIS
    APP2 --> REDIS
    APP3 --> REDIS
    APP4 --> REDIS

    APP1 --> DB
    APP2 --> DB
    APP3 --> DB
    APP4 --> DB

    CW[CloudWatch] --> ASG[Auto Scaling Group]
    ASG -. manages .-> APP1
    ASG -. manages .-> APP2
    ASG -. manages .-> APP3
    ASG -. manages .-> APP4
```

---

## 7.2 Network Placement

A common setup places the load balancer in public subnets and application resources in private subnets:

| Subnet Type | Typical Contents |
|---|---|
| Public | Internet-facing load balancer; NAT Gateway (when private instances need outbound internet access) |
| Private | Application EC2 instances, ECS tasks, internal services, databases, caches |

The application instances usually do not need public IP addresses.

---

## 7.3 Security-Group Flow

A clean security-group relationship is:

```mermaid
flowchart TD
    I[Internet] -->|HTTPS 443| ALBSG[ALB Security Group]
    ALBSG -->|"Application port, allowed only from ALB security group"| APPSG[Application Security Group]
    APPSG -->|"Database port, allowed only from application security group"| DBSG[Database Security Group]
```

Example:

| Security Group | Inbound Rule |
|---|---|
| ALB SG | TCP 443 from approved internet sources |
| App SG | TCP 8000 from ALB SG |
| DB SG | TCP 5432 from App SG |

Avoid opening the application port directly to the whole internet when the application should only receive traffic through the load balancer.

---

## 7.4 Stateless Application Design

Horizontal scaling works best when every instance can handle any request.

Avoid storing important runtime state only on one instance.

### Avoid

```mermaid
flowchart LR
    US[User session] --> LPM[Local process memory]
    UF[Uploaded file] --> LCF[Local container filesystem]
    STL[Scheduled task lock] --> LV[Local variable]
```

### Prefer

```mermaid
flowchart LR
    US[User session] --> R[Redis or signed cookie]
    UF[Uploaded file] --> S3[Amazon S3]
    PD[Persistent data] --> DB[Database]
    TQ[Task queue] --> Q["SQS, RabbitMQ or managed queue"]
    SC[Shared cache] --> EC[ElastiCache]
```

---

## 7.5 Example Health Endpoint

A lightweight FastAPI health endpoint:

```python
from fastapi import FastAPI, Response, status

app = FastAPI()

@app.get("/health")
async def health_check(response: Response) -> dict[str, str]:
    application_ready = True

    if not application_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unhealthy"}

    return {"status": "healthy"}
```

A Django example:

```python
from django.http import JsonResponse

def health_check(request):
    return JsonResponse({"status": "healthy"}, status=200)
```

The endpoint should be fast and predictable. Do not perform a large business workflow during every health check.

---

# 8. Scaling Policies and Metrics

## 8.1 Target Tracking Scaling

Target tracking tries to keep a selected metric near a target value — for example, "keep average ASG CPU utilization near 50%":

```mermaid
flowchart LR
    C1["Current CPU = 78%"] --> A1[Scale out]
    C2["Current CPU = 25%"] --> A2[Eventually scale in]
    C3["Current CPU = 51%"] --> A3[Maintain capacity]
```

This is usually the best starting point because it behaves similarly to a thermostat. Common target metrics: average CPU utilization, ALB request count per target, a custom CloudWatch metric, average ECS service CPU, or average ECS service memory.

---

## 8.2 Step Scaling

Step scaling changes capacity by different amounts depending on how far a metric is from its threshold.

Example:

| CPU Level | Action |
|---|---|
| 60% to 70% | Add 1 instance |
| 70% to 85% | Add 2 instances |
| Above 85% | Add 4 instances |

Step scaling is useful when you understand workload behavior and need more direct control.

---

## 8.3 Simple Scaling

Simple scaling performs one scaling adjustment and then waits for a cooldown period.

It is easier to understand but less flexible than target tracking or step scaling.

For most modern EC2 Auto Scaling use cases, begin with target tracking unless a specific requirement calls for another policy.

---

## 8.4 Scheduled Scaling

Scheduled scaling changes capacity at known times, for example:

| Time Window | Minimum | Desired |
|---|---|---|
| Monday–Friday at 8:30 AM | 6 | 8 |
| Monday–Friday at 8:00 PM | 2 | 2 |

Suitable for:

- Office-hour applications
- Planned campaigns
- Payroll processing
- Daily batch workloads
- Known sale events
- Scheduled examinations or registrations

Scheduled scaling does not react to unexpected traffic by itself — it is often combined with dynamic scaling.

---

## 8.5 Predictive Scaling

Predictive scaling analyzes historical patterns and forecasts required capacity — suitable when traffic has repeatable patterns such as daily peaks, weekly business cycles, regular media events, or repeated batch workloads. It is often combined with dynamic scaling: predictive scaling prepares capacity ahead of expected demand, while dynamic scaling responds to whatever is unexpected.

---

## 8.6 Selecting the Correct Metric

A useful scaling metric should generally change in proportion to the workload.

### CPU Utilization

Good when:

- Requests are CPU-intensive
- All instances have similar capacity
- CPU pressure closely represents workload

Weak when:

- Application waits mainly on external APIs
- Work is memory-bound
- Traffic is mostly I/O-bound
- CPU remains low while latency increases

### Request Count Per Target

Good when:

- Each request requires similar work
- Application runs behind an ALB
- You know approximately how many requests one target can process

For example, with a safe capacity of 1,000 requests/minute per target, a target value of 700 requests/minute leaves operational headroom.

### Queue Depth

Good for asynchronous workers — the example metric is messages available divided by active workers. If 10,000 messages exist but only two workers are running, CPU may not immediately show the true backlog; queue depth is more directly connected to the work waiting to be processed.

### Latency

Latency is useful for alerting, but it may be a difficult primary scaling metric because it can increase for reasons unrelated to compute capacity.

Examples:

- Slow database
- Third-party API delay
- Lock contention
- Network issue

### Memory Utilization

Useful for memory-heavy applications, though EC2 memory metrics normally require an agent or custom metric because standard EC2 metrics do not provide operating-system memory utilization automatically.

### Business Metrics

Examples:

- Active video-processing jobs
- Documents waiting for OCR
- Orders waiting for validation
- Concurrent game sessions
- Number of active websocket connections

A business metric can be more accurate than CPU when it directly describes demand.

---

## 8.7 Metric Selection Guide

| Workload | Strong Starting Metric |
|---|---|
| CPU-heavy API | Average CPU |
| Standard web API | ALB request count per target |
| Async workers | Queue messages per worker |
| Memory-heavy service | Memory utilization |
| WebSocket service | Active connections |
| Scheduled batch job | Queue depth plus scheduled scaling |
| Predictable daily traffic | Predictive plus target tracking |
| Unpredictable public traffic | Target tracking with sufficient maximum capacity |

---

## 8.8 Instance Warmup

New instances require time to:

- Boot the operating system
- Run user data
- Pull application artifacts
- Start containers
- Connect to dependencies
- Warm caches
- Pass health checks

During warmup, the scaling system should avoid treating partially initialized capacity as fully available — measure actual startup time, don't guess. For container workloads, image size and image-pull time can materially affect scale-out speed.

---

## 8.9 Cooldown and Stabilization

Scaling systems need protection from rapid repeated changes. Without stabilization, the system can thrash: scale out → metric falls → scale in → metric rises → scale out again (called **thrashing** or **flapping**).

Useful controls include:

- Instance warmup
- Scaling cooldown
- Conservative scale-in
- Multiple evaluation periods
- Minimum capacity
- Appropriate health thresholds
- ECS scaling stabilization behavior
- Kubernetes stabilization windows

Scale out quickly enough to protect users, but scale in carefully.

---

# 9. Health Checks and Graceful Traffic Handling

## 9.1 A Good Health Check

A production health endpoint should answer a clear question: can this target safely receive traffic? A useful design separates **liveness** (is the process running? — typically `/live`) from **readiness** (is the application ready to serve requests? — typically `/ready`). The load balancer should normally use a readiness-style check.

---

## 9.2 Avoid Overloading the Health Endpoint

Do not make every health check perform:

- A full database report
- A third-party API call
- A large file operation
- A heavy cache rebuild
- Multiple slow dependency checks

A dependency failure should only fail readiness when the application truly cannot serve useful traffic without that dependency.

---

## 9.3 Deregistration Delay and Connection Draining

When a target is removed:

1. Stop sending new requests.
2. Allow active requests to complete.
3. Terminate the process after a grace period.

```mermaid
flowchart LR
    NR[New requests] --> AHT[Another healthy target]
    ER[Existing requests] --> ATF[Allowed to finish]
    TT[Target termination] --> ADP[After drain period]
```

This matters for file uploads, report generation requests, long API calls, streaming responses, and graceful deployments.

The application shutdown timeout should align with the load balancer's deregistration behavior and the orchestrator's termination grace period.

---

## 9.4 Slow Start

A newly healthy target may not immediately be ready for full traffic. It may still be:

- Warming application caches
- Establishing database pools
- Loading machine-learning models
- Compiling templates
- Initializing runtime components

A gradual traffic ramp can protect such targets where the selected load-balancer configuration supports it.

---

## 9.5 Health Threshold Example

| Setting | Value |
|---|---|
| Health-check interval | 15 seconds |
| Timeout | 5 seconds |
| Healthy threshold | 2 checks |
| Unhealthy threshold | 3 checks |

With these values, healthy registration takes around 30 seconds after successful checks, and unhealthy detection takes up to around 45 seconds (plus timing variation). Choose values based on application recovery behavior and tolerance for false failures.

---

# 10. Docker and Container Scaling

## 10.1 Docker Does Not Automatically Mean Auto-Scaling

Docker packages and runs an application in containers, but it does not by itself provide multi-host scheduling, automatic scaling from metrics, cloud load balancing, cross-host service discovery, or automatic node provisioning.

Those capabilities come from an orchestrator or cloud platform such as:

- Amazon ECS
- Amazon EKS
- Kubernetes
- Docker Swarm
- Nomad
- A custom platform

---

## 10.2 Manual Docker Compose Scaling

A service can be scaled manually: `docker compose up -d --scale web=3`

Example Compose service:

```yaml
services:
  web:
    build: .
    expose:
      - "8000"
    environment:
      APP_ENV: production
```

This creates multiple containers for the `web` service.

Important limitations:

- It is manual scaling, not metric-based auto-scaling.
- A fixed host-port mapping such as `8000:8000` cannot be reused by multiple containers on the same host.
- A reverse proxy or orchestrator is needed to distribute external traffic.
- Scaling only on one machine does not protect against that machine failing.

---

## 10.3 Local Reverse-Proxy Example

```mermaid
flowchart LR
    U[User] --> NGINX[Nginx / Reverse Proxy]
    NGINX --> C1[Web Container 1]
    NGINX --> C2[Web Container 2]
    NGINX --> C3[Web Container 3]
```

A simplified Nginx configuration:

```nginx
upstream web_backend {
    server web1:8000;
    server web2:8000;
    server web3:8000;
}

server {
    listen 80;

    location / {
        proxy_pass http://web_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

For dynamic container replicas, use service discovery or an orchestrator rather than maintaining backend addresses manually.

---

## 10.4 Docker Swarm

Docker Swarm supports replicated services and an ingress routing mesh.

Example:

```bash
docker service create \
  --name web \
  --replicas 3 \
  --publish published=80,target=8000 \
  my-web-image:latest
```

Manual scaling: `docker service scale web=6`

Swarm distributes service tasks across nodes and can route published traffic to active service containers. An external load balancer can also be placed in front of the Swarm nodes.

Swarm service scaling is still based on desired replicas unless additional automation changes that desired count.

---

## 10.5 Amazon ECS with an Application Load Balancer

A common container architecture is:

```mermaid
flowchart LR
    U[Users] --> ALB[Application Load Balancer]
    ALB --> TG[ECS Target Group]

    subgraph ECS[ECS Service]
        T1[Task 1]
        T2[Task 2]
        T3[Task 3]
    end

    TG --> T1
    TG --> T2
    TG --> T3

    CW[CloudWatch Metrics] --> AAS[Application Auto Scaling]
    AAS --> ECS
```

The ECS service maintains the desired task count, replaces failed tasks, registers tasks with the load balancer, deregisters stopped tasks, and can scale task count automatically.

---

## 10.6 ECS Scaling Layers

For ECS on Fargate:

```text
Service Auto Scaling → changes number of ECS tasks
AWS Fargate          → provides underlying compute automatically
```

For ECS on EC2:

```text
Service Auto Scaling → changes number of ECS tasks
Cluster Auto Scaling → changes number of EC2 container instances
```

Both layers must have enough capacity.

Example failure:

| Item | Value |
|---|---|
| ECS desired tasks | 20 |
| EC2 cluster capacity | 10 |
| Result | Remaining tasks stay pending |

---

## 10.7 ECS Target-Tracking Example

Conceptual policy:

| Setting | Value |
|---|---|
| Minimum tasks | 2 |
| Maximum tasks | 20 |
| Target metric | ECSServiceAverageCPUUtilization |
| Target value | 50% |

Another useful metric for an ALB-backed service is `ALBRequestCountPerTarget`, which scales based on the average request load handled by each target.

---

## 10.8 Kubernetes Equivalent

The equivalent concepts are:

| AWS / General Concept | Kubernetes Concept |
|---|---|
| Application replicas | Pods |
| Stable service endpoint | Service |
| HTTP routing entry point | Ingress or Gateway |
| Pod auto-scaling | Horizontal Pod Autoscaler |
| Node auto-scaling | Cluster Autoscaler or managed node auto-scaling |
| Health checks | Liveness, readiness and startup probes |
| Desired task count | Replica count |

Pod scaling and node scaling are different layers, similar to ECS service scaling and ECS cluster capacity scaling.

---

# 11. Monitoring and Troubleshooting

## 11.1 Important Load-Balancer Metrics

Useful CloudWatch metrics include:

- Request count
- Request count per target
- Target response time
- Healthy host count
- Unhealthy host count
- Target connection errors
- Load-balancer-generated HTTP errors
- Target-generated HTTP errors
- Active connections
- New connections
- Processed bytes

Metric names and availability depend on the load-balancer type.

---

## 11.2 Important Auto Scaling Metrics

Useful signals include:

- Number of instances in service
- Desired capacity
- Pending instances
- Terminating instances
- Average CPU utilization
- Network throughput
- Request count per target
- Custom business metrics
- Scaling activity failures

---

## 11.3 Logs to Collect

| Source | What to Collect |
|---|---|
| Application Load Balancer | Access logs, connection logs where applicable, AWS WAF logs if WAF is enabled, CloudTrail management events |
| Application | Request logs, error logs, startup logs, shutdown logs, health-check logs, correlation or request IDs |
| Auto Scaling | Scaling activity history, lifecycle hook status, EC2 system logs, user-data or cloud-init logs, CloudWatch alarms |

---

## 11.4 Common Symptom: Targets Stay Unhealthy

Check:

1. Is the application listening on the expected port?
2. Is it bound to `0.0.0.0`, not only `127.0.0.1`?
3. Does the target security group allow traffic from the load balancer security group?
4. Is the health-check path correct?
5. Does the health endpoint return an accepted status code?
6. Is the target group using the correct protocol?
7. Is the application startup slower than the health thresholds allow?
8. Is a dependency causing readiness to fail?
9. Are network ACLs blocking traffic?
10. Is the container port correctly mapped in ECS?

---

## 11.5 Common Symptom: Auto Scaling Does Not Launch Instances

Check:

- Maximum capacity has not already been reached
- Scaling policy is enabled
- CloudWatch metric has data
- Alarm state is correct
- Launch template is valid
- AMI is available
- Subnets have free IP addresses
- EC2 service quotas permit more instances
- IAM service-linked role is valid
- The selected instance type is available
- User-data failure is not causing immediate health-check replacement

---

## 11.6 Common Symptom: Auto Scaling Launches Too Late

Possible causes:

- Metric period is too long
- Too many alarm evaluation periods
- Instance startup is slow
- Docker image is too large
- User data performs lengthy installation
- Minimum capacity is too low
- Scaling metric does not reflect demand early enough
- Maximum capacity is too low
- No scheduled or predictive preparation exists for known peaks

Possible improvements:

- Bake dependencies into the AMI or container image
- Keep images smaller
- Increase minimum capacity
- Use request count or queue depth instead of delayed CPU signals
- Configure scheduled scaling for known events
- Load test to measure real startup and saturation points

---

## 11.7 Common Symptom: Frequent Scale-Out and Scale-In

Possible causes:

- Target value is too aggressive
- Scale-in is too fast
- Workload is highly bursty
- Warmup is incorrect
- Metric period is too short for the workload
- Health checks are unstable
- Minimum capacity is too low

Use a stable metric, appropriate warmup, and more conservative scale-in behavior.

---

# 12. Cost and Capacity Planning

## 12.1 Minimum Capacity Is a Reliability Decision

Setting minimum capacity to zero or one may save money, but can increase:

- Cold-start delay
- Risk during instance failure
- Deployment risk
- Impact of Availability Zone problems
- Recovery time

For a production multi-AZ web application, minimum capacity is commonly at least two, with capacity distributed across zones — the exact value depends on the workload's availability objective.

---

## 12.2 Maximum Capacity Is a Safety Boundary

Maximum capacity protects against unexpected cost growth, runaway scaling, downstream overload, and account quota pressure — but a maximum that is too low prevents the system from handling legitimate traffic.

Choose it using:

- Load-test results
- Per-instance capacity
- Traffic forecast
- Cost limit
- Database and dependency capacity
- EC2 service quotas

---

## 12.3 Capacity Formula

A simple starting estimate:

```text
Required instances =
Peak requests per second
────────────────────────────
Safe requests per second per instance
```

Example:

| Item | Value |
|---|---|
| Peak demand | 2,400 requests/second |
| Safe capacity per instance | 300 requests/second |
| Required baseline capacity | 2,400 / 300 = 8 instances |

Add headroom — for example, 8 × 1.25 = 10 instances. This formula is only useful when validated with realistic load testing.

---

## 12.4 Keep Dependency Capacity in Mind

Scaling the application tier may move the bottleneck elsewhere.

```mermaid
flowchart TD
    A[More application instances] --> B[More database connections]
    A --> C[More cache connections]
    A --> D[More outbound API calls]
    A --> E[More queue consumers]
    A --> F[More log volume]
```

Confirm that dependencies can support the maximum application capacity.

---

## 12.5 EC2 Purchase Options

An ASG can mix On-Demand Instances, Reserved capacity or Savings Plans for predictable baseline usage, Spot Instances for interruptible capacity, and mixed instance types — typically a stable baseline on On-Demand or covered usage, with burst capacity drawing from a mixture that may include Spot. Use Spot only when the application can tolerate interruptions and the scaling design maintains sufficient reliable capacity.

---

# 13. Practical Design Scenarios

## 13.1 Public REST API

**Requirements:** HTTPS, multiple API instances, path routing, automatic scale-out, no server-side local sessions.

```mermaid
flowchart TD
    R53[Route 53] --> ALB[Application Load Balancer]
    ALB --> TG[Target Group]
    TG --> ASG[EC2 Auto Scaling Group across 2+ AZs]
    ASG --> DEP["RDS / ElastiCache / S3"]
```

**Scaling metric:** ALB request count per target, or average CPU if CPU strongly represents request load.

---

## 13.2 Background OCR Workers

**Requirements:** documents enter a queue, workers process them asynchronously, traffic is not direct HTTP traffic.

**Design:** API → S3 + Queue → Worker Auto Scaling Group → Database. A load balancer may not be needed for the worker tier.

**Scaling metric:** queue backlog per worker (visible queue messages ÷ running workers) instead of ALB request count.

---

## 13.3 WebSocket Application

**Requirements:** long-lived connections, many concurrent users, graceful connection handling.

**Design considerations:**

- Choose an LB that supports the protocol and required behavior
- Scale on active connections or another workload-specific metric
- Use shared state or a message broker
- Configure long-enough idle timeouts
- Handle graceful termination carefully
- Avoid relying only on request rate

---

## 13.4 Predictable Office-Hour Application

**Traffic pattern:** low usage 8 PM–8 AM, high usage 9 AM–6 PM.

| Policy | Behavior |
|---|---|
| Scheduled scaling | Increase minimum capacity before 9 AM; reduce minimum capacity after 7 PM |
| Target tracking | Respond to unexpected demand during the day |

---

## 13.5 Flash Sale

**Requirements:** a large, known traffic event with a sudden burst and high business impact.

**Approach:**

- Load test before the event
- Increase minimum capacity in advance
- Use scheduled scaling
- Keep dynamic scaling enabled
- Increase relevant service quotas
- Validate database capacity
- Use caching and CDN where appropriate
- Set a realistic maximum capacity
- Monitor errors, latency and saturation in real time

Do not rely only on reactive scaling when instances require several minutes to become ready.

---

# 14. Production Best Practices

## 14.1 Architecture

- Deploy application capacity across at least two Availability Zones.
- Keep application instances in private subnets when possible.
- Use a load balancer as the controlled application entry point.
- Make application instances stateless.
- Store files in object storage rather than local instance disks.
- Store sessions in a shared system when server-side sessions are required.

## 14.2 Load Balancer

- Use ALB for HTTP/HTTPS routing and NLB for transport-level requirements.
- Redirect HTTP to HTTPS.
- Manage certificates centrally.
- Use health checks that represent readiness.
- Configure deregistration delay for graceful shutdown.
- Review idle timeout for long-running connections.
- Protect public endpoints with appropriate network controls and AWS WAF where relevant.
- Enable and retain access logs according to operational and compliance needs.

## 14.3 Auto Scaling

- Define realistic minimum, desired and maximum capacity.
- Use a launch template as the repeatable instance definition.
- Start with target tracking for straightforward dynamic scaling.
- Use scheduled scaling for known traffic windows.
- Use predictive scaling where historical patterns are meaningful.
- Measure application warmup.
- Scale in more conservatively than scale out.
- Use lifecycle hooks when startup or shutdown requires controlled work.
- Test unhealthy-instance replacement.

## 14.4 Metrics

- Scale on a metric that is proportional to demand.
- Do not assume CPU is always the correct signal.
- Use queue depth for worker systems.
- Use requests per target for many ALB-backed APIs.
- Publish custom metrics when infrastructure metrics do not represent business workload.
- Set alarms for high latency, target errors, unhealthy hosts and failed scaling activities.

## 14.5 Deployment

- Make startup automated and repeatable.
- Avoid downloading large dependencies during every boot.
- Prefer prebuilt AMIs or container images.
- Ensure new instances pass readiness checks before receiving traffic.
- Use rolling, blue/green or canary deployment strategies.
- Confirm old targets drain before termination.

## 14.6 Testing

- Perform load testing with production-like request patterns.
- Test sudden traffic bursts.
- Test gradual traffic growth.
- Test instance failure.
- Test Availability Zone impact where practical.
- Test scale-out time from alarm to healthy target.
- Test scale-in while long-running requests are active.
- Verify the database and cache under maximum application capacity.

---
