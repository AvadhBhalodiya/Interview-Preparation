---
title: "Design a Payment System"
group: "Classic Designs"
order: 10
---

# Design a Payment System

> **Category:** System Design  
> **Level:** Intermediate backend developer  
> **Goal:** Design a reliable, secure, scalable payment platform that can accept payments, track their lifecycle, maintain accurate financial records, process refunds, and recover safely from failures.

---

# 1. What Are We Designing?

We are designing an online payment platform used by applications such as an e-commerce website, subscription platform, marketplace, insurance portal, or SaaS product.

The platform should allow a merchant application to:

- Create a payment for an order.
- Collect money through an external payment service provider.
- Handle synchronous and asynchronous payment results.
- Prevent duplicate charges when clients retry requests.
- Track authorization, capture, failure, cancellation, and settlement.
- Issue full or partial refunds.
- Maintain an auditable record of every financial movement.
- Reconcile internal records with provider and bank reports.
- Support multiple payment providers in the future.

A payment system does **not** move money entirely by itself. It usually integrates with payment gateways, processors, card networks, banks, wallets, or real-time payment rails.

```mermaid
flowchart LR
    Customer --> Merchant[Merchant Application]
    Merchant --> PaymentSystem[Payment System]
    PaymentSystem --> PSP[Payment Service Provider]
    PSP --> Network[Card / Bank / Wallet Network]
    Network --> Issuer[Customer Bank]
    PSP --> Acquirer[Merchant Acquiring Bank]
```

The payment system is responsible for coordinating this workflow and keeping its own records correct, even when external systems are slow, unavailable, or send duplicate messages.

---

# 2. Scope and Assumptions

## 2.1 Included in the design

This design covers:

- One-time online payments.
- Authorization and capture.
- Synchronous provider API calls.
- Asynchronous provider webhooks.
- Refunds and reversals.
- Internal double-entry ledger.
- Reconciliation.
- Multiple currencies.
- Horizontal scaling.
- High availability and disaster recovery.
- Card, bank, wallet, or UPI-like provider integrations through a common abstraction.

## 2.2 Outside the initial scope

The first version does not deeply implement:

- Recurring billing and subscription scheduling.
- Merchant onboarding and KYC.
- Cross-border foreign-exchange conversion.
- Tax calculation.
- Payouts to marketplace sellers.
- Full dispute evidence management.
- Direct integration with card networks.

These can be added later without changing the core payment model.

## 2.3 Example scale

Assume:

- 10 million registered customers.
- 1 million active merchants.
- 20 million payment attempts per day.
- Average: approximately 230 payment attempts per second.
- Peak traffic: 10 times average, approximately 2,300 attempts per second.
- A payment creates several database writes and events.
- Financial records must never be silently lost or duplicated.

The exact numbers are less important than showing how the design grows with traffic.

---

# 3. Requirements

## 3.1 Functional requirements

### Payment creation

A merchant creates a payment using:

- Merchant identifier.
- Order identifier.
- Amount.
- Currency.
- Customer identifier.
- Payment method token.
- Idempotency key.

### Payment processing

The system should:

- Validate the request.
- Select a payment provider.
- Authorize or charge the payment.
- Store provider references.
- Return the latest known payment state.

### Payment status

The merchant should be able to retrieve the current payment state.

### Capture

For an authorization-first flow, the merchant can capture the amount later.

### Cancellation

An uncaptured authorization can be cancelled or allowed to expire.

### Refund

A captured payment can be partially or fully refunded.

### Webhooks

The system receives provider events and sends merchant events.

### Ledger

Every confirmed money movement creates balanced ledger entries.

### Reconciliation

The system compares internal data with provider settlement reports.

---

## 3.2 Non-functional requirements

### Correctness

Correctness is more important than very low latency. A slow payment is inconvenient; an incorrect financial record is dangerous.

### Availability

The payment API should remain available during partial failures wherever possible.

A realistic target might be:

- Payment creation API: 99.99% availability.
- Read-only payment status API: 99.99% or higher.
- Background reconciliation: lower immediate availability, but strict completion targets.

### Durability

Once the system tells a merchant that a payment is successful, the associated records must be durably stored.

### Idempotency

Retrying the same logical operation must not charge the customer twice.

### Auditability

The system must record:

- Who initiated an operation.
- What request was received.
- Which state transitions occurred.
- Which provider response was received.
- Which ledger entries were posted.

### Security

Sensitive payment data must be protected in transit and at rest. Raw card data should ideally never enter the merchant backend or the core payment service.

### Consistency

Strong consistency is required inside critical financial transaction boundaries. Eventual consistency is acceptable for notifications, dashboards, search, and analytics.

---

# 4. Payment Domain Fundamentals

## 4.1 Payment intent

A payment intent represents the merchant's intention to collect a specific amount from a customer.

It is useful because a payment can require multiple steps:

- Payment method collection.
- Customer authentication.
- Authorization.
- Capture.
- Retry with another provider.
- Asynchronous confirmation.

The payment intent remains the stable business object while individual attempts may succeed or fail.

```text
Payment Intent: PAY-1001
Amount: ₹5,000
Order: ORD-9001

Attempt 1 -> Provider A -> Timed out
Attempt 2 -> Provider A -> Declined
Attempt 3 -> Provider B -> Succeeded
```

## 4.2 Payment attempt

A payment attempt represents one execution against a provider.

A single payment may have multiple attempts, but only one successful money-collecting result should be accepted unless the business explicitly supports split or installment payments.

## 4.3 Authorization

Authorization asks the issuer or payment rail to reserve or approve funds.

No final settlement may have occurred yet.

Example:

```text
Hotel blocks ₹10,000 on a card at check-in.
```

## 4.4 Capture

Capture confirms that the merchant wants to collect an authorized amount.

Example:

```text
Hotel captures ₹8,500 at check-out and releases the remaining hold.
```

## 4.5 Settlement

Settlement is the movement of funds through financial institutions to the merchant's acquiring account. It usually happens later than the customer-facing payment response.

A payment can be `CAPTURED` internally while provider settlement is still pending.

## 4.6 Refund

A refund is a new financial operation that sends some or all captured funds back to the customer.

It should not simply modify the original payment amount.

## 4.7 Reversal

A reversal releases an authorization or cancels a transaction before final settlement.

## 4.8 Chargeback or dispute

A chargeback occurs when the customer challenges a payment through the issuer or payment network. It is different from a merchant-initiated refund.

---

# 5. High-Level Architecture

```mermaid
flowchart TB
    Client[Web / Mobile Client]
    Merchant[Merchant Backend]
    Gateway[API Gateway]
    Auth[Authentication and Rate Limiting]
    PaymentAPI[Payment API]
    Orchestrator[Payment Orchestrator]
    Risk[Risk Service]
    Router[Provider Router]
    AdapterA[Provider A Adapter]
    AdapterB[Provider B Adapter]
    DB[(Primary Payment Database)]
    Ledger[Ledger Service]
    LedgerDB[(Ledger Database)]
    Outbox[(Outbox Table)]
    Broker[(Event Broker)]
    Webhook[Provider Webhook Service]
    MerchantWebhook[Merchant Notification Service]
    Reconciliation[Reconciliation Service]
    ObjectStore[(Reports / Object Storage)]

    Client --> Merchant
    Merchant --> Gateway
    Gateway --> Auth
    Auth --> PaymentAPI
    PaymentAPI --> Orchestrator
    Orchestrator --> Risk
    Orchestrator --> Router
    Router --> AdapterA
    Router --> AdapterB
    AdapterA --> PSPA[Provider A]
    AdapterB --> PSPB[Provider B]
    Orchestrator --> DB
    Orchestrator --> Ledger
    Ledger --> LedgerDB
    Orchestrator --> Outbox
    Outbox --> Broker
    PSPA --> Webhook
    PSPB --> Webhook
    Webhook --> DB
    Webhook --> Outbox
    Broker --> MerchantWebhook
    MerchantWebhook --> Merchant
    Reconciliation --> PSPA
    Reconciliation --> PSPB
    Reconciliation --> DB
    Reconciliation --> LedgerDB
    Reconciliation --> ObjectStore
```

## 5.1 Main design principle

Keep the synchronous request path focused on the minimum work required to safely process the payment:

1. Authenticate and validate.
2. Check idempotency.
3. Persist the payment operation.
4. Call the selected provider.
5. Persist the result.
6. Commit required ledger and outbox records.
7. Return the latest known state.

Move non-critical work to asynchronous consumers:

- Email and push notifications.
- Merchant webhooks.
- Analytics.
- Search indexing.
- Reporting.
- Data warehouse updates.

---

# 6. Core Components

## 6.1 API gateway

Responsibilities:

- TLS termination.
- Authentication.
- Request size limits.
- Rate limiting.
- Routing.
- Request identifiers.
- Basic schema validation.
- DDoS protection.

The gateway should not contain payment business logic.

## 6.2 Payment API

The Payment API exposes merchant-facing endpoints.

Responsibilities:

- Validate merchant ownership.
- Validate amount and currency.
- Require idempotency keys for mutating operations.
- Return stable payment representations.
- Hide provider-specific details.

## 6.3 Payment orchestrator

The orchestrator owns the payment workflow.

Responsibilities:

- State-transition validation.
- Risk-check coordination.
- Provider routing.
- Authorization and capture workflow.
- Retry classification.
- Recording payment attempts.
- Updating the latest payment state.
- Triggering ledger and event creation.

This is the central domain component, but it should not become a single large class. Internally, it can be divided into command handlers such as:

```text
CreatePaymentHandler
ConfirmPaymentHandler
CapturePaymentHandler
CancelPaymentHandler
RefundPaymentHandler
ApplyProviderEventHandler
```

## 6.4 Provider router

The router selects a provider based on rules such as:

- Payment method type.
- Currency.
- Customer or merchant country.
- Provider health.
- Cost.
- Historical success rate.
- Merchant preference.
- Transaction amount.
- Regulatory constraints.

The router should make a deterministic decision for a specific attempt and store that decision.

## 6.5 Provider adapters

Each adapter translates the internal domain model to a provider-specific API.

```python
from typing import Protocol


class PaymentProvider(Protocol):
    def authorize(self, request: "AuthorizeRequest") -> "ProviderResult": ...

    def capture(self, request: "CaptureRequest") -> "ProviderResult": ...

    def cancel(self, request: "CancelRequest") -> "ProviderResult": ...

    def refund(self, request: "RefundRequest") -> "ProviderResult": ...

    def fetch_payment(self, provider_payment_id: str) -> "ProviderResult": ...
```

The rest of the system should not directly depend on a provider SDK.

## 6.6 Risk service

The risk service evaluates the transaction before money movement.

Possible outputs:

- `ALLOW`
- `DENY`
- `REVIEW`
- `REQUIRE_ADDITIONAL_AUTHENTICATION`

The payment system should define what happens when risk evaluation is unavailable. For high-risk payments, fail closed. For low-risk, low-value use cases, a carefully controlled fail-open policy may be acceptable.

## 6.7 Ledger service

The ledger service records balanced financial entries.

It must be:

- Append-oriented.
- Strongly consistent.
- Auditable.
- Protected from arbitrary updates.
- Able to reject unbalanced transactions.

## 6.8 Webhook service

The webhook service:

- Receives provider callbacks.
- Verifies signatures.
- Stores the raw event.
- Deduplicates events.
- Acknowledges quickly.
- Processes the event asynchronously.

## 6.9 Reconciliation service

The reconciliation service compares:

- Internal payment records.
- Internal ledger records.
- Provider transaction data.
- Provider settlement reports.
- Bank statements, when available.

It creates exceptions for investigation or automated correction.

---

# 7. Payment Lifecycle and State Machine

A payment should follow explicit state transitions. Avoid allowing any service to write arbitrary status strings.

## 7.1 Suggested payment states

| State | Meaning |
|---|---|
| `CREATED` | Payment object exists but processing has not started. |
| `REQUIRES_PAYMENT_METHOD` | A valid payment method is still needed. |
| `REQUIRES_CONFIRMATION` | Payment is ready to be confirmed. |
| `REQUIRES_ACTION` | Customer authentication or another action is required. |
| `PROCESSING` | Provider result is pending or asynchronous. |
| `AUTHORIZED` | Funds are approved or reserved but not fully captured. |
| `PARTIALLY_CAPTURED` | Part of the authorization has been captured. |
| `CAPTURED` | Funds have been captured. |
| `PARTIALLY_REFUNDED` | Some captured funds have been refunded. |
| `REFUNDED` | Captured amount has been fully refunded. |
| `CANCELLED` | Payment was cancelled before completion. |
| `FAILED` | Payment cannot continue without a new attempt or method. |
| `DISPUTED` | A dispute or chargeback exists. |

## 7.2 State diagram

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> REQUIRES_PAYMENT_METHOD
    CREATED --> REQUIRES_CONFIRMATION
    REQUIRES_PAYMENT_METHOD --> REQUIRES_CONFIRMATION
    REQUIRES_CONFIRMATION --> REQUIRES_ACTION
    REQUIRES_CONFIRMATION --> PROCESSING
    REQUIRES_CONFIRMATION --> AUTHORIZED
    REQUIRES_CONFIRMATION --> CAPTURED
    REQUIRES_CONFIRMATION --> FAILED
    REQUIRES_ACTION --> PROCESSING
    REQUIRES_ACTION --> AUTHORIZED
    REQUIRES_ACTION --> CAPTURED
    REQUIRES_ACTION --> FAILED
    PROCESSING --> AUTHORIZED
    PROCESSING --> CAPTURED
    PROCESSING --> FAILED
    AUTHORIZED --> PARTIALLY_CAPTURED
    AUTHORIZED --> CAPTURED
    AUTHORIZED --> CANCELLED
    PARTIALLY_CAPTURED --> CAPTURED
    PARTIALLY_CAPTURED --> CANCELLED
    CAPTURED --> PARTIALLY_REFUNDED
    CAPTURED --> REFUNDED
    CAPTURED --> DISPUTED
    PARTIALLY_REFUNDED --> PARTIALLY_REFUNDED
    PARTIALLY_REFUNDED --> REFUNDED
    PARTIALLY_REFUNDED --> DISPUTED
```

## 7.3 Transition validation

Use a transition matrix or domain method:

```python
ALLOWED_TRANSITIONS = {
    "CREATED": {"REQUIRES_PAYMENT_METHOD", "REQUIRES_CONFIRMATION", "CANCELLED"},
    "REQUIRES_CONFIRMATION": {
        "REQUIRES_ACTION",
        "PROCESSING",
        "AUTHORIZED",
        "CAPTURED",
        "FAILED",
    },
    "PROCESSING": {"AUTHORIZED", "CAPTURED", "FAILED"},
    "AUTHORIZED": {"PARTIALLY_CAPTURED", "CAPTURED", "CANCELLED"},
    "CAPTURED": {"PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"},
}


def validate_transition(current: str, target: str) -> None:
    if target not in ALLOWED_TRANSITIONS.get(current, set()):
        raise ValueError(f"Invalid payment transition: {current} -> {target}")
```

The database should also use optimistic locking so two workers cannot independently apply conflicting transitions.

---

# 8. End-to-End Payment Flow

## 8.1 Successful immediate-capture flow

```mermaid
sequenceDiagram
    autonumber
    participant M as Merchant Backend
    participant API as Payment API
    participant DB as Payment DB
    participant R as Risk Service
    participant P as Payment Provider
    participant L as Ledger
    participant O as Outbox

    M->>API: POST /payments + Idempotency-Key
    API->>DB: Insert payment + idempotency record
    API->>R: Evaluate transaction
    R-->>API: ALLOW
    API->>DB: Insert payment attempt
    API->>P: Create/confirm payment
    P-->>API: Payment captured
    API->>DB: Update attempt and payment
    API->>L: Post balanced ledger transaction
    API->>O: Store PaymentCaptured event
    API-->>M: 201 CAPTURED
```

In implementation, updates to payment state, ledger instructions, and outbox records should be coordinated carefully. Depending on service boundaries, the payment service may write a durable ledger command rather than directly calling a separate ledger database in the same request.

## 8.2 Customer authentication flow

```mermaid
sequenceDiagram
    autonumber
    participant C as Customer Browser
    participant M as Merchant Backend
    participant API as Payment API
    participant P as Provider

    C->>M: Submit checkout
    M->>API: Confirm payment
    API->>P: Confirm payment
    P-->>API: Requires customer action
    API-->>M: REQUIRES_ACTION + action data
    M-->>C: Return provider challenge details
    C->>P: Complete authentication
    P-->>API: Webhook: payment succeeded
    API->>API: Verify, deduplicate, apply transition
    M->>API: GET /payments/{id}
    API-->>M: CAPTURED
```

The browser redirect is not the source of truth. The provider API response or signed webhook should confirm the final state.

## 8.3 Timeout flow

```mermaid
sequenceDiagram
    autonumber
    participant M as Merchant
    participant API as Payment API
    participant P as Provider
    participant J as Recovery Worker

    M->>API: Confirm payment
    API->>P: Charge request
    P--xAPI: Response lost / timeout
    API-->>M: PROCESSING or UNKNOWN
    API->>J: Schedule status verification
    J->>P: Fetch payment by provider reference
    P-->>J: Payment succeeded
    J->>API: Apply CAPTURED result
    API-->>M: Merchant webhook: CAPTURED
```

A timeout is not equal to failure. The provider may have processed the request even though the response was lost.

---

# 9. API Design

Use stable business APIs that are independent of any provider.

## 9.1 Create a payment

```http
POST /v1/payments
Authorization: Bearer <merchant-token>
Idempotency-Key: 7aa28514-9e32-4b1c-85e1-8e7e29e56487
Content-Type: application/json
```

```json
{
  "merchant_order_id": "ORD-9001",
  "amount": 500000,
  "currency": "INR",
  "capture_method": "automatic",
  "customer_id": "cus_123",
  "payment_method_token": "pm_tok_abc",
  "description": "Annual insurance premium",
  "metadata": {
    "policy_id": "POL-7001"
  }
}
```

Represent monetary values in the smallest supported currency unit.

For INR:

```text
₹5,000.00 -> 500000 paise
```

Response:

```json
{
  "id": "pay_01JZ8QK2P2",
  "merchant_order_id": "ORD-9001",
  "amount": 500000,
  "currency": "INR",
  "status": "PROCESSING",
  "capture_method": "automatic",
  "amount_authorized": 0,
  "amount_captured": 0,
  "amount_refunded": 0,
  "created_at": "2026-08-03T06:30:00Z"
}
```

## 9.2 Retrieve payment

```http
GET /v1/payments/pay_01JZ8QK2P2
```

## 9.3 Confirm payment

Useful when payment creation and confirmation are separate steps.

```http
POST /v1/payments/pay_01JZ8QK2P2/confirm
Idempotency-Key: 0eff083d-fc90-4186-9231-e9376ea7a7aa
```

## 9.4 Capture payment

```http
POST /v1/payments/pay_01JZ8QK2P2/captures
Idempotency-Key: 7850f683-aa23-4190-8c32-6fec0cf288a3
```

```json
{
  "amount": 400000
}
```

## 9.5 Cancel authorization

```http
POST /v1/payments/pay_01JZ8QK2P2/cancel
Idempotency-Key: b7e7edb7-d7cf-4c66-8f30-e0cb56cdf4d0
```

## 9.6 Create refund

```http
POST /v1/refunds
Idempotency-Key: 85683ac1-c30b-48f1-9799-ec29b601aa5d
```

```json
{
  "payment_id": "pay_01JZ8QK2P2",
  "amount": 100000,
  "reason": "customer_request"
}
```

## 9.7 API response principles

- Never expose internal database IDs when stable public IDs are available.
- Return machine-readable error codes.
- Include a request ID for support and tracing.
- Return the latest **known** state, not an invented final result.
- Use `202 Accepted` when the operation is accepted but still processing.
- Use `409 Conflict` for invalid state transitions or idempotency conflicts.
- Do not return sensitive provider payloads to merchants.

Example error:

```json
{
  "error": {
    "code": "PAYMENT_ALREADY_CAPTURED",
    "message": "The payment has already been fully captured.",
    "request_id": "req_01JZ8RM0VT"
  }
}
```

---

# 10. Data Model

## 10.1 Entity relationship diagram

```mermaid
erDiagram
    MERCHANT ||--o{ PAYMENT : owns
    CUSTOMER ||--o{ PAYMENT : initiates
    PAYMENT ||--o{ PAYMENT_ATTEMPT : has
    PAYMENT ||--o{ CAPTURE : has
    PAYMENT ||--o{ REFUND : has
    PAYMENT ||--o{ PAYMENT_EVENT : produces
    PAYMENT_ATTEMPT ||--o{ PROVIDER_EVENT : receives
    LEDGER_TRANSACTION ||--|{ LEDGER_ENTRY : contains
    PAYMENT ||--o{ LEDGER_TRANSACTION : references
    REFUND ||--o{ LEDGER_TRANSACTION : references

    PAYMENT {
        uuid id PK
        uuid merchant_id FK
        string merchant_order_id
        bigint amount
        string currency
        string status
        string capture_method
        bigint amount_authorized
        bigint amount_captured
        bigint amount_refunded
        int version
        timestamp created_at
        timestamp updated_at
    }

    PAYMENT_ATTEMPT {
        uuid id PK
        uuid payment_id FK
        string provider
        string provider_payment_id
        string operation
        string status
        string request_reference
        string error_code
        timestamp created_at
        timestamp updated_at
    }

    REFUND {
        uuid id PK
        uuid payment_id FK
        bigint amount
        string currency
        string status
        string provider_refund_id
        timestamp created_at
        timestamp updated_at
    }

    LEDGER_TRANSACTION {
        uuid id PK
        string reference_type
        uuid reference_id
        string transaction_type
        timestamp posted_at
    }

    LEDGER_ENTRY {
        uuid id PK
        uuid ledger_transaction_id FK
        uuid account_id
        string direction
        bigint amount
        string currency
    }
```

## 10.2 Payment table

```sql
CREATE TABLE payments (
    id UUID PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL UNIQUE,
    merchant_id UUID NOT NULL,
    merchant_order_id VARCHAR(100) NOT NULL,
    customer_id UUID,
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    status VARCHAR(40) NOT NULL,
    capture_method VARCHAR(20) NOT NULL,
    amount_authorized BIGINT NOT NULL DEFAULT 0,
    amount_captured BIGINT NOT NULL DEFAULT 0,
    amount_refunded BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (merchant_id, merchant_order_id)
);
```

The uniqueness rule on `(merchant_id, merchant_order_id)` depends on business semantics. Some merchants may legitimately create multiple payments for one order. In that case use a separate merchant payment reference or allow attempts under one payment intent.

## 10.3 Payment attempts

```sql
CREATE TABLE payment_attempts (
    id UUID PRIMARY KEY,
    payment_id UUID NOT NULL REFERENCES payments(id),
    attempt_number INTEGER NOT NULL,
    operation VARCHAR(30) NOT NULL,
    provider VARCHAR(40) NOT NULL,
    provider_payment_id VARCHAR(150),
    provider_request_id VARCHAR(150),
    status VARCHAR(40) NOT NULL,
    error_category VARCHAR(40),
    error_code VARCHAR(100),
    response_summary JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, attempt_number)
);
```

Avoid storing complete sensitive provider responses unless necessary. Store a redacted summary and archive encrypted raw payloads only when required.

## 10.4 Idempotency records

```sql
CREATE TABLE idempotency_records (
    merchant_id UUID NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    operation VARCHAR(100) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    resource_type VARCHAR(40),
    resource_id UUID,
    http_status INTEGER,
    response_body JSONB,
    locked_until TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_id, idempotency_key)
);
```

## 10.5 Provider events

```sql
CREATE TABLE provider_events (
    provider VARCHAR(40) NOT NULL,
    provider_event_id VARCHAR(200) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    signature_verified BOOLEAN NOT NULL,
    processing_status VARCHAR(30) NOT NULL,
    payment_id UUID,
    payload_location TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (provider, provider_event_id)
);
```

## 10.6 Indexes

Common indexes:

```sql
CREATE INDEX idx_payments_merchant_created
    ON payments (merchant_id, created_at DESC);

CREATE INDEX idx_payments_status_updated
    ON payments (status, updated_at);

CREATE INDEX idx_attempts_provider_payment
    ON payment_attempts (provider, provider_payment_id);

CREATE INDEX idx_refunds_payment
    ON refunds (payment_id, created_at DESC);
```

Avoid indexing every field. Payment tables are write-heavy, and each index increases write cost.

---

# 11. Idempotency and Duplicate Prevention

Idempotency is one of the most important parts of payment design.

## 11.1 The problem

The merchant sends a payment request. The provider charges the customer, but the network connection fails before the merchant receives the response.

The merchant retries:

```text
Request 1 -> Customer charged -> Response lost
Request 2 -> Customer charged again
```

Without idempotency, one logical purchase can become two charges.

## 11.2 Idempotency key behavior

The merchant sends a unique key for each logical operation:

```http
Idempotency-Key: checkout-ORD-9001-payment-v1
```

The server stores:

- Merchant ID.
- Idempotency key.
- Operation.
- Hash of normalized request parameters.
- Processing state.
- Created resource ID.
- Final response.

## 11.3 Processing algorithm

```mermaid
flowchart TD
    A[Receive mutating request] --> B[Normalize request and calculate hash]
    B --> C{Idempotency record exists?}
    C -- No --> D[Insert PROCESSING record]
    D --> E[Execute operation]
    E --> F[Store result and response]
    F --> G[Return response]
    C -- Yes --> H{Request hash matches?}
    H -- No --> I[Return 409 idempotency conflict]
    H -- Yes --> J{Existing status}
    J -- COMPLETED --> K[Return stored response]
    J -- PROCESSING --> L[Return current operation status or retry later]
    J -- FAILED_RETRYABLE --> M[Resume using controlled recovery rule]
```

## 11.4 Database race handling

Use a unique constraint to ensure only one request owns the key.

```sql
INSERT INTO idempotency_records (...)
VALUES (...)
ON CONFLICT DO NOTHING;
```

If insert succeeds, the request is the owner.

If it conflicts, read the existing record and return or wait according to its status.

Do not rely on a cache alone. A cache can improve performance, but the authoritative idempotency record should be durable.

## 11.5 Provider idempotency

Also pass a stable operation key to the payment provider when supported.

Use separate keys for separate operations:

```text
payment:create:pay_123
payment:capture:pay_123:capture_1
payment:refund:pay_123:refund_1
```

The internal idempotency layer protects your API. Provider idempotency protects retries between your system and the provider.

## 11.6 Idempotency is not only request deduplication

A correct design also needs:

- Unique provider event IDs.
- Unique ledger transaction references.
- Unique merchant webhook delivery IDs.
- State-transition validation.
- Safe consumers that tolerate duplicate events.

At-least-once delivery plus idempotent consumers is normally more practical than assuming perfect end-to-end exactly-once delivery.

---

# 12. Ledger and Money Movement

The payment table describes workflow state. It is not sufficient as the financial source of truth.

Use an immutable double-entry ledger for actual financial accounting.

## 12.1 Why a separate ledger?

A payment status can change for operational reasons:

```text
PROCESSING -> CAPTURED -> REFUNDED -> DISPUTED
```

Financial movements should remain as a permanent history:

```text
Capture posted: +₹5,000 merchant receivable
Refund posted:  -₹1,000 merchant receivable
Chargeback:      -₹4,000 merchant receivable
```

Never overwrite the original capture entry. Add compensating transactions.

## 12.2 Double-entry rule

For every ledger transaction:

```text
Total debits = Total credits
```

The exact debit and credit naming depends on the accounting model, but the entries must balance per currency.

## 12.3 Simplified capture example

Customer pays ₹5,000. Provider fee is ₹100. Merchant is owed ₹4,900.

```text
Transaction: Payment captured

Debit   Provider Receivable       ₹5,000
Credit  Merchant Payable          ₹4,900
Credit  Fee Revenue                 ₹100
-----------------------------------------
Total debits                     ₹5,000
Total credits                    ₹5,000
```

This example uses platform books. Account direction depends on how the organization defines assets, liabilities, revenue, and contra accounts.

## 12.4 Settlement example

The provider transfers ₹5,000 into the platform bank account:

```text
Debit   Bank Cash                 ₹5,000
Credit  Provider Receivable       ₹5,000
```

## 12.5 Merchant payout example

The platform pays ₹4,900 to the merchant:

```text
Debit   Merchant Payable          ₹4,900
Credit  Bank Cash                 ₹4,900
```

## 12.6 Refund example

A ₹1,000 refund reduces the merchant amount and creates a customer refund liability or provider payable, depending on the settlement timing.

The important design rule is:

> Model a refund as a new ledger transaction linked to the original payment, not as an update to old ledger entries.

## 12.7 Ledger schema

```sql
CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY,
    reference_type VARCHAR(40) NOT NULL,
    reference_id UUID NOT NULL,
    transaction_type VARCHAR(40) NOT NULL,
    currency CHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (reference_type, reference_id, transaction_type)
);

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY,
    ledger_transaction_id UUID NOT NULL REFERENCES ledger_transactions(id),
    account_id UUID NOT NULL,
    direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency CHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Before committing:

```sql
-- Conceptual validation performed in application or database procedure
SUM(DEBIT amount) = SUM(CREDIT amount)
```

## 12.8 Ledger invariants

- Entries are immutable.
- Every transaction balances.
- One transaction contains one currency unless FX entries are explicitly modeled.
- Every external operation has a unique ledger reference.
- Balances are derived from entries or maintained as validated projections.
- Corrections use new compensating entries.
- Posting is authorized and audited.

---

# 13. Consistency and Transaction Boundaries

## 13.1 Strong consistency areas

Use a relational transaction for closely related critical writes such as:

- Payment state update.
- Payment attempt update.
- Idempotency result update.
- Outbox event insertion.

Example:

```sql
BEGIN;

UPDATE payment_attempts
SET status = 'SUCCEEDED'
WHERE id = :attempt_id;

UPDATE payments
SET status = 'CAPTURED',
    amount_captured = :amount,
    version = version + 1
WHERE id = :payment_id
  AND version = :expected_version;

INSERT INTO outbox_events (...);

UPDATE idempotency_records
SET status = 'COMPLETED',
    response_body = :response
WHERE merchant_id = :merchant_id
  AND idempotency_key = :key;

COMMIT;
```

## 13.2 Optimistic locking

Two workers may process the same payment because of duplicate webhooks or retries.

Use a version column:

```sql
UPDATE payments
SET status = 'CAPTURED', version = version + 1
WHERE id = :payment_id
  AND version = :current_version;
```

If zero rows are updated, another worker changed the payment. Reload and re-evaluate the transition.

## 13.3 Pessimistic locking

For very short, high-contention operations such as calculating the remaining refundable amount, use:

```sql
SELECT *
FROM payments
WHERE id = :payment_id
FOR UPDATE;
```

Keep the transaction short. Never hold a database lock while waiting for an external provider call.

## 13.4 External calls cannot join local transactions

This is unsafe:

```text
BEGIN DB TRANSACTION
  Update payment
  Call provider over network
  Wait several seconds
COMMIT
```

It holds locks too long and still cannot atomically commit the provider and database.

Instead:

1. Persist the intended operation.
2. Commit.
3. Call the provider with an idempotency key.
4. Persist the result in a new short transaction.
5. Recover uncertain outcomes through provider status checks.

---

# 14. Events, Queues, and the Transactional Outbox

## 14.1 The dual-write problem

Suppose the payment service does this:

```text
1. Update database to CAPTURED
2. Publish PaymentCaptured event
```

Failure cases:

- Database succeeds, event publish fails: merchant never receives notification.
- Event publish succeeds, database fails: consumers see a capture that is not in the database.

## 14.2 Transactional outbox

Write the domain update and event record in the same database transaction.

```mermaid
sequenceDiagram
    participant S as Payment Service
    participant DB as Payment DB
    participant P as Outbox Publisher
    participant Q as Event Broker

    S->>DB: BEGIN
    S->>DB: Update payment to CAPTURED
    S->>DB: Insert PaymentCaptured into outbox
    S->>DB: COMMIT
    P->>DB: Read unpublished outbox rows
    P->>Q: Publish event
    Q-->>P: Acknowledge
    P->>DB: Mark event published
```

The publisher may send an event more than once if it crashes after publishing but before marking the row. Therefore, consumers must deduplicate using `event_id`.

## 14.3 Outbox table

```sql
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_unpublished
    ON outbox_events (next_attempt_at)
    WHERE published_at IS NULL;
```

## 14.4 Event example

```json
{
  "event_id": "evt_01JZ8V60PA",
  "event_type": "payment.captured",
  "event_version": 1,
  "occurred_at": "2026-08-03T06:34:10Z",
  "payment": {
    "id": "pay_01JZ8QK2P2",
    "merchant_id": "mer_123",
    "amount": 500000,
    "currency": "INR",
    "status": "CAPTURED"
  }
}
```

Version events so consumers can evolve independently.

## 14.5 Queue partitioning

Partition events by `payment_id` so events for one payment preserve order within a partition.

```text
Partition key = payment_id
```

Global ordering is unnecessary and expensive. Per-payment ordering is normally sufficient.

## 14.6 Dead-letter queue

After controlled retries, move repeatedly failing messages to a dead-letter queue.

Store:

- Original event.
- Consumer name.
- Failure reason.
- Attempt count.
- First and last failure time.

Provide a replay tool that keeps the original event ID.

---

# 15. Webhook Processing

Provider webhooks are asynchronous notifications such as:

```text
payment.authorized
payment.captured
payment.failed
refund.succeeded
refund.failed
dispute.created
```

## 15.1 Webhook endpoint flow

```mermaid
flowchart TD
    A[Provider sends webhook] --> B[Read raw request body]
    B --> C[Verify signature and timestamp]
    C --> D{Valid?}
    D -- No --> E[Return 400 or 401]
    D -- Yes --> F[Insert provider event with unique event ID]
    F --> G{Already exists?}
    G -- Yes --> H[Return 2xx]
    G -- No --> I[Enqueue processing]
    I --> J[Return 2xx quickly]
    J --> K[Worker maps provider event]
    K --> L[Fetch provider state when necessary]
    L --> M[Apply valid state transition]
    M --> N[Write outbox event]
```

## 15.2 Signature verification

Verification should use:

- Raw request bytes.
- Provider signature header.
- Endpoint secret.
- Timestamp tolerance.
- Constant-time comparison where applicable.

Do not parse and reserialize JSON before verifying a signature if the provider signs the raw body.

## 15.3 Acknowledge quickly

The webhook endpoint should normally:

1. Verify.
2. Deduplicate and persist.
3. Enqueue.
4. Return success.

Long business processing inside the HTTP request increases provider retries and duplicate deliveries.

## 15.4 Duplicate events

Providers may retry events. Deduplicate using:

```text
(provider, provider_event_id)
```

Do not deduplicate only by payment ID because different events can legitimately exist for one payment.

## 15.5 Out-of-order events

Possible arrival order:

```text
payment.captured arrives first
payment.authorized arrives later
```

Solutions:

- Validate state transitions.
- Store event creation time and provider sequence number when available.
- Fetch current provider state for ambiguous events.
- Make older events harmless after a terminal or later state is applied.

## 15.6 Merchant webhooks

Send merchant notifications asynchronously.

Each delivery should include:

- Event ID.
- Event type.
- Event creation time.
- Payment ID.
- Current payment state.
- Signature.
- Delivery attempt ID.

Retry with exponential backoff and jitter.

```text
Attempt 1: immediately
Attempt 2: after 30 seconds
Attempt 3: after 2 minutes
Attempt 4: after 10 minutes
Attempt 5: after 1 hour
...
```

The merchant must deduplicate by event ID.

---

# 16. Refunds, Reversals, and Chargebacks

## 16.1 Refund constraints

Before creating a refund:

```text
remaining_refundable = amount_captured - amount_refunded - pending_refund_amount
```

Require:

```text
requested_refund <= remaining_refundable
```

Lock the payment or use an atomic conditional update to prevent two concurrent refunds exceeding the captured amount.

## 16.2 Partial refund example

```text
Captured amount:        ₹5,000
Completed refunds:      ₹1,000
Pending refunds:          ₹500
Remaining refundable:  ₹3,500
```

## 16.3 Refund state machine

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> PROCESSING
    PROCESSING --> SUCCEEDED
    PROCESSING --> FAILED
    FAILED --> PROCESSING: controlled retry
    SUCCEEDED --> [*]
```

## 16.4 Refund API call timeout

A refund timeout is also an uncertain outcome.

Do not immediately create a second refund. Query the provider using the refund operation key or provider reference.

## 16.5 Reversal

If a payment is authorized but not captured, cancel the authorization rather than creating a refund.

```text
AUTHORIZED -> CANCELLED
```

## 16.6 Chargeback

A chargeback is provider- or network-initiated. On a dispute event:

- Create a dispute record.
- Freeze or reserve the disputed amount if required.
- Post ledger entries for the dispute movement.
- Notify the merchant.
- Track evidence and deadline outside the initial payment workflow.

---

# 17. Failure Handling and Recovery

Payment systems must be designed around ambiguous and partial failures.

## 17.1 Failure categories

### Validation failure

Examples:

- Invalid amount.
- Unsupported currency.
- Missing payment method.

Do not retry without changing the request.

### Business decline

Examples:

- Insufficient funds.
- Authentication failed.
- Payment method expired.
- Risk rejected.

Retry only according to the provider's advice and business rules.

### Technical transient failure

Examples:

- Connection reset.
- Provider `5xx`.
- Rate limit.
- Temporary database issue.

Retry with backoff, jitter, and a bounded attempt count.

### Unknown outcome

Examples:

- Provider request timed out after being sent.
- Worker crashed after provider success but before local persistence.

Do not classify as failure. Mark the operation `UNKNOWN` or `PROCESSING` and run a status inquiry.

## 17.2 Retry policy

```text
retry_delay = min(base_delay * 2^attempt, maximum_delay) + random_jitter
```

Use different policies for:

- Safe read requests.
- Idempotent provider writes.
- Webhook delivery.
- Event consumption.
- Reconciliation fetches.

Never blindly retry a payment write unless the provider supports idempotency or you can safely check the result first.

## 17.3 Circuit breaker

When a provider has high failure rates:

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN: failure threshold exceeded
    OPEN --> HALF_OPEN: cooldown elapsed
    HALF_OPEN --> CLOSED: probe succeeds
    HALF_OPEN --> OPEN: probe fails
```

- `CLOSED`: requests flow normally.
- `OPEN`: fail fast or route to another provider.
- `HALF_OPEN`: allow limited test requests.

Do not automatically fail over after an ambiguous write unless duplicate charging is prevented across providers.

## 17.4 Provider failover risk

Unsafe sequence:

```text
Provider A request times out
System immediately sends charge to Provider B
Provider A actually succeeded
Provider B also succeeds
```

Safe approach:

1. Mark Provider A attempt as uncertain.
2. Query Provider A by idempotency key or provider reference.
3. Wait for webhook when appropriate.
4. Fail over only after proving the first attempt did not succeed or after a carefully defined business timeout and compensation strategy.

## 17.5 Recovery workers

Run background jobs for:

- Payments stuck in `PROCESSING`.
- Attempts with unknown outcome.
- Unpublished outbox events.
- Pending merchant webhooks.
- Refunds awaiting confirmation.
- Ledger commands awaiting posting.
- Reconciliation exceptions.

Use distributed leases or `FOR UPDATE SKIP LOCKED` to divide work safely.

```sql
SELECT id
FROM payment_attempts
WHERE status = 'UNKNOWN'
  AND updated_at < NOW() - INTERVAL '2 minutes'
FOR UPDATE SKIP LOCKED
LIMIT 100;
```

---

# 18. Reconciliation

Reconciliation proves that your internal view matches external reality.

It is not optional in a production payment system.

## 18.1 Why reconciliation is needed

Even with correct APIs and webhooks:

- A webhook can be permanently missed.
- A provider response can be lost.
- A software bug can post an incorrect state.
- Settlement can differ because of fees, taxes, reserves, or adjustments.
- A provider can correct a transaction later.

## 18.2 Reconciliation layers

### Operational reconciliation

Compare individual internal payments with provider transactions.

```text
Internal CAPTURED but provider FAILED -> critical mismatch
Internal PROCESSING but provider CAPTURED -> repair internal state
Internal CAPTURED but provider record missing -> investigate
```

### Financial reconciliation

Compare aggregated amounts:

```text
Captured gross amount
- Refunds
- Provider fees
- Chargebacks
- Reserves
= Expected settlement
```

### Bank reconciliation

Compare provider settlement records with actual bank credits and debits.

## 18.3 Reconciliation pipeline

```mermaid
flowchart LR
    Provider[Provider Reports / APIs] --> Ingest[Report Ingestion]
    Ingest --> Normalize[Normalize Provider Format]
    Normalize --> Match[Matching Engine]
    Payments[(Payment DB)] --> Match
    Ledger[(Ledger DB)] --> Match
    Match --> Matched[Matched Records]
    Match --> Exceptions[Exception Queue]
    Exceptions --> AutoRepair[Automated Repair]
    Exceptions --> Ops[Operations Review]
    AutoRepair --> Audit[Audit Log]
    Ops --> Audit
```

## 18.4 Matching keys

Use several levels:

1. Exact provider transaction ID.
2. Internal payment ID stored in provider metadata.
3. Merchant ID + order ID.
4. Amount + currency + date window.
5. Manual investigation for remaining records.

## 18.5 Reconciliation should not silently rewrite history

Repairs must create:

- A correction command.
- An audit record.
- New ledger entries if financial correction is required.
- A reference to the source report or provider API response.

---

# 19. Scaling the System

## 19.1 Stateless API layer

Payment API instances should be stateless and horizontally scalable behind a load balancer.

Store workflow state in durable systems, not process memory.

## 19.2 Database scaling

Start with a relational database because payments need:

- Transactions.
- Unique constraints.
- Row locking.
- Strong consistency.
- Flexible operational queries.

Typical evolution:

```text
Single primary + replicas
        ↓
Larger primary and connection pooling
        ↓
Partition large tables
        ↓
Shard by merchant or payment ID
        ↓
Separate payment, ledger, webhook, and reporting stores
```

## 19.3 Read replicas

Use replicas for:

- Merchant payment history.
- Support dashboards.
- Reports.
- Analytics extraction.

Read the primary after writes when immediate consistency is required.

## 19.4 Partitioning

Time-based partitioning works well for append-heavy tables:

- Payment events.
- Provider events.
- Webhook deliveries.
- Audit logs.
- Outbox archives.

Hash partitioning by merchant or payment ID helps distribute hot traffic.

## 19.5 Sharding

Possible shard key:

```text
shard = hash(merchant_id) % number_of_shards
```

Advantages:

- Merchant data is colocated.
- Most merchant queries hit one shard.

Challenges:

- Large merchants can create hot shards.
- Cross-merchant reporting becomes harder.
- Resharding requires careful tooling.

A virtual-shard mapping provides flexibility:

```text
merchant -> virtual shard -> physical database
```

## 19.6 Ledger scaling

Ledger writes should prioritize consistency over arbitrary horizontal distribution.

Partition by:

- Legal entity.
- Currency.
- Merchant group.
- Account namespace.

Keep all entries for one ledger transaction on the same partition.

## 19.7 Event broker scaling

Partition topics by payment ID or merchant ID.

Example topics:

```text
payment-events
refund-events
provider-webhook-events
ledger-commands
merchant-webhook-deliveries
reconciliation-results
```

## 19.8 Caching

Cache only data that can tolerate staleness:

- Merchant configuration.
- Provider routing rules.
- Currency metadata.
- Public payment status for repeated polling, with a short TTL.

Do not use cache as the source of truth for:

- Current refundable amount.
- Ledger balance.
- Idempotency ownership.
- Payment state transitions.

## 19.9 Backpressure

When a downstream system is slow:

- Bound queues.
- Limit concurrent provider calls.
- Apply merchant quotas.
- Reject excess load predictably.
- Delay non-critical processing.
- Preserve critical payment and ledger paths.

---

# 20. Security and Compliance

As of 2026, PCI DSS v4.0.1 is the active PCI DSS version published by the PCI Security Standards Council. Exact compliance obligations depend on how cardholder data enters and flows through the system.

## 20.1 Minimize sensitive data scope

Best approach:

```mermaid
sequenceDiagram
    participant B as Customer Browser
    participant H as Provider-Hosted UI / SDK
    participant P as Payment Provider
    participant M as Merchant Backend

    B->>H: Enter card details
    H->>P: Send card data directly
    P-->>H: Return payment-method token
    H-->>B: Token created
    B->>M: Send token, not raw card data
```

The core payment API receives a token such as:

```text
pm_tok_abc123
```

It should not receive the card number or security code.

## 20.2 Never store prohibited authentication data

Do not store sensitive authentication data such as card verification values after authorization. Follow the applicable PCI requirements and provider guidance.

## 20.3 Encryption

Use:

- TLS for all network communication.
- Encryption at rest for databases, queues, object storage, and backups.
- Field-level encryption for highly sensitive identifiers.
- Managed keys or HSM-backed keys for critical cryptographic operations.
- Regular key rotation.

## 20.4 Tokenization

Replace sensitive payment credentials with tokens.

```text
Card PAN -> Provider vault -> Payment method token
```

The token should be useless outside its intended merchant, account, or provider context where possible.

## 20.5 Access control

Use least privilege:

- Payment API can create payment records.
- Webhook processor can update allowed payment fields.
- Ledger posting service can append entries.
- Reporting jobs receive read-only access.
- Human operators use audited, role-based tools.

For sensitive operations, combine RBAC with contextual checks such as merchant ownership, environment, amount limit, and approval status.

## 20.6 Secrets

Store provider credentials in a managed secret store, not source code or plain environment files committed to Git.

Use:

- Rotation.
- Versioning.
- Short-lived credentials when supported.
- Separate credentials per environment.
- Restricted access paths.

## 20.7 Logging rules

Never log:

- Full card numbers.
- Card verification values.
- Unredacted authentication tokens.
- Full bank credentials.
- Secrets or signing keys.

Use structured redaction before logs leave the application process.

## 20.8 Webhook security

- Verify cryptographic signatures.
- Check timestamp tolerance.
- Use HTTPS.
- Rotate webhook secrets.
- Deduplicate event IDs.
- Optionally allow-list provider network ranges only as an additional control, not a replacement for signatures.

## 20.9 Audit logs

Record security-sensitive actions:

```text
Manual refund approved
Merchant routing rule changed
Provider secret rotated
Ledger adjustment posted
Reconciliation exception overridden
User permissions changed
```

Audit records should be append-only and protected from the application role that performs the original action.

---

# 21. Fraud and Risk Controls

Fraud controls run before or during payment authorization.

## 21.1 Common signals

- Payment amount.
- Merchant category.
- Customer history.
- Device fingerprint.
- IP reputation.
- Billing and shipping mismatch.
- Velocity: number of attempts over time.
- Repeated failures across cards.
- Country mismatch.
- Suspicious account creation patterns.
- Provider risk score.

## 21.2 Risk workflow

```mermaid
flowchart LR
    Payment[Payment Request] --> Rules[Real-Time Rules]
    Rules --> Features[Feature Store]
    Features --> Model[Fraud Model]
    Model --> Decision{Decision}
    Decision -->|Allow| Provider[Send to Provider]
    Decision -->|Require Action| Challenge[Additional Authentication]
    Decision -->|Review| Queue[Manual Review]
    Decision -->|Deny| Reject[Reject Payment]
```

## 21.3 Velocity counters

Redis or another low-latency store can maintain counters such as:

```text
attempts per card token per 10 minutes
attempts per customer per hour
failed attempts per IP per day
total value per merchant per minute
```

Risk decisions and the input summary should be stored for auditability.

## 21.4 Risk availability trade-off

Risk checks add latency and another dependency.

Use:

- Strict timeouts.
- Circuit breakers.
- Cached static rules.
- Local fallback rules.
- Risk-based fail-open or fail-closed policy.

---

# 22. Observability and Operations

## 22.1 Structured logs

Include identifiers such as:

```text
request_id
trace_id
merchant_id
payment_id
attempt_id
provider
provider_request_id
idempotency_key_hash
event_id
```

Do not log the raw idempotency key if merchants may place sensitive information inside it. Store or log a hash.

## 22.2 Metrics

### Business metrics

- Payment attempts per second.
- Authorization success rate.
- Capture success rate.
- Payment success rate by provider, currency, method, and merchant.
- Refund rate.
- Chargeback rate.
- Average payment amount.
- Settlement variance.

### Technical metrics

- API latency percentiles.
- Provider latency percentiles.
- Provider error rate.
- Database transaction latency.
- Lock wait time.
- Queue lag.
- Outbox unpublished count.
- Webhook retry count.
- Stuck payments.
- Reconciliation mismatch count.
- Ledger posting delay.

## 22.3 Tracing

Trace the full path:

```text
Merchant request
  -> Payment API
  -> Risk service
  -> Provider adapter
  -> Provider API
  -> Payment persistence
  -> Outbox
  -> Event consumer
  -> Merchant webhook
```

Do not place raw sensitive data in spans.

## 22.4 Alerts

Alert on symptoms that affect money or customer experience:

- Success rate drops significantly.
- Provider timeouts exceed threshold.
- Payments remain `PROCESSING` too long.
- Ledger transactions become unbalanced.
- Outbox backlog grows.
- Reconciliation mismatches exceed threshold.
- Merchant webhook queue is delayed.
- Database replication lag becomes unsafe.

## 22.5 Operational dashboard

A useful payment operations dashboard shows:

```text
Current success rate
Payment volume and value
Provider health
Payments in unknown state
Webhook delivery health
Refund backlog
Settlement status
Reconciliation exceptions
```

---

# 23. Multi-Provider Routing

Supporting multiple providers improves reach, cost optimization, and resilience, but increases complexity.

## 23.1 Routing inputs

```text
payment_method
currency
country
merchant
amount
provider availability
provider historical success rate
cost
fraud score
regulatory rule
```

## 23.2 Weighted routing

Example:

```text
Provider A: 70%
Provider B: 30%
```

Use consistent hashing for controlled experiments so retries do not randomly move between providers.

## 23.3 Health-aware routing

Track provider health using:

- Recent latency.
- Timeout rate.
- Technical error rate.
- Authorization rate compared with baseline.
- Provider status API.

A low authorization rate can be caused by customer quality rather than provider health, so compare like-for-like traffic.

## 23.4 Provider abstraction model

Normalize provider results:

```python
from dataclasses import dataclass
from enum import Enum


class ProviderOutcome(str, Enum):
    SUCCEEDED = "SUCCEEDED"
    REQUIRES_ACTION = "REQUIRES_ACTION"
    DECLINED = "DECLINED"
    PROCESSING = "PROCESSING"
    UNKNOWN = "UNKNOWN"
    TECHNICAL_FAILURE = "TECHNICAL_FAILURE"


@dataclass(frozen=True)
class ProviderResult:
    outcome: ProviderOutcome
    provider_payment_id: str | None
    provider_request_id: str | None
    retryable: bool
    error_code: str | None
    action_data: dict | None
```

Store both normalized values and a restricted provider-specific code for support.

## 23.5 Smart retry versus double-charge safety

Improving success rate is useful, but duplicate prevention has higher priority.

Safe routing rule:

```text
Declined with known final response -> another method/provider may be attempted
Technical failure before request was sent -> safe controlled retry
Timeout after request was sent -> verify outcome before failover
```

---

# 24. Deployment and Disaster Recovery

## 24.1 Multi-availability-zone deployment

Deploy:

- API instances across multiple availability zones.
- Database with synchronous standby or managed multi-zone failover.
- Event brokers with replicated partitions.
- Redundant NAT or private connectivity paths to providers.

## 24.2 Regional strategy

A practical first design uses one active region and one disaster-recovery region.

```mermaid
flowchart LR
    Users --> DNS[Global DNS / Traffic Manager]
    DNS --> Primary[Primary Region]
    DNS -. failover .-> DR[DR Region]
    Primary --> PrimaryDB[(Primary DB)]
    PrimaryDB -->|replication| DRDB[(DR DB)]
    Primary --> PrimaryBroker[(Primary Broker)]
    PrimaryBroker -->|replication| DRBroker[(DR Broker)]
```

Active-active payment writes across regions are difficult because of:

- Idempotency ownership.
- Global uniqueness.
- Conflicting state transitions.
- Ledger ordering.
- Provider region restrictions.

Use active-active only when business requirements justify the complexity.

## 24.3 RPO and RTO

Define separately for each capability:

| Capability | Example RPO | Example RTO |
|---|---:|---:|
| Payment and ledger records | Near zero | Minutes |
| Merchant webhook delivery | Minutes | Tens of minutes |
| Analytics | Hours | Hours |
| Historical reports | Hours | One day |

These are examples, not universal targets. Financial and regulatory requirements should determine the actual values.

## 24.4 Backups

Use:

- Automated database snapshots.
- Point-in-time recovery.
- Cross-region copies where required.
- Encrypted backups.
- Regular restore testing.

A backup that has never been restored is an assumption, not a recovery plan.

## 24.5 Disaster recovery testing

Test:

- Database failover.
- Provider outage.
- Queue outage.
- Lost webhook events.
- Region evacuation.
- Secret rotation failure.
- Replay from outbox or event log.
- Reconciliation after recovery.

---

# 25. Practical Technology Choices

The design is technology-independent, but a realistic implementation could use:

| Area | Practical choices |
|---|---|
| API | FastAPI, Django, Spring Boot, Go, Node.js |
| Primary database | PostgreSQL, Aurora PostgreSQL, Cloud SQL PostgreSQL |
| Connection pool | PgBouncer or managed proxy |
| Cache and counters | Redis |
| Event broker | Kafka, Amazon MSK, SQS/SNS, RabbitMQ, Google Pub/Sub |
| Workflow scheduling | Temporal, managed queues, durable job tables |
| Object storage | Amazon S3, Google Cloud Storage, Azure Blob Storage |
| Secrets | AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Vault |
| Encryption keys | Managed KMS, HSM-backed service |
| Observability | OpenTelemetry, Prometheus, Grafana, CloudWatch, Datadog |
| Data warehouse | BigQuery, Snowflake, Redshift |

## 25.1 Start simple

A strong first production version can be:

```text
Modular payment service
PostgreSQL
Redis
Transactional outbox
Managed queue
One provider adapter
Webhook worker
Ledger module or service
Daily reconciliation
```

Do not introduce dozens of microservices before the domain and traffic require them.

## 25.2 When to separate services

Separate a component when it needs independent:

- Scaling.
- Security boundary.
- Availability target.
- Data ownership.
- Release lifecycle.
- Team ownership.

The ledger is a strong candidate for separation because it has stricter invariants and access control than normal payment workflow data.

---

# 26. Important Trade-offs

## 26.1 Synchronous versus asynchronous response

### Synchronous

Advantages:

- Simple merchant experience.
- Immediate result.

Disadvantages:

- Higher latency.
- More sensitive to provider outages.
- Cannot avoid asynchronous provider behavior.

### Asynchronous

Advantages:

- Better resilience.
- Handles long-running payment methods.

Disadvantages:

- Merchant must poll or consume webhooks.
- More complex state handling.

Practical design: return immediate results when available, but always support `PROCESSING` and asynchronous completion.

## 26.2 One database versus database per service

### One database

Advantages:

- Easy ACID transactions.
- Simpler operations.
- Faster development.

Disadvantages:

- Strong coupling.
- Harder independent scaling.
- Larger failure domain.

### Database per service

Advantages:

- Clear ownership.
- Independent scaling.
- Stronger boundaries.

Disadvantages:

- Distributed consistency.
- More reconciliation.
- More operational complexity.

Start with clear schemas and ownership. Split only when justified.

## 26.3 Strong consistency versus availability

Use strong consistency for:

- Idempotency ownership.
- Refund limits.
- Ledger posting.
- State transitions.

Use eventual consistency for:

- Notifications.
- Search.
- Analytics.
- Merchant dashboards where slight delay is acceptable.

## 26.4 Build versus use a provider

Most companies should integrate with established payment providers rather than directly connecting to payment networks.

Build internal capabilities for:

- Payment orchestration.
- Provider abstraction.
- Merchant APIs.
- Ledger.
- Reconciliation.
- Risk rules.
- Reporting.

Use providers for:

- Payment credential vaulting.
- Network connectivity.
- Authentication flows.
- Local payment method integration.
- Regulatory and acquiring capabilities.

## 26.5 Exactly-once versus effectively-once

Perfect end-to-end exactly-once processing across HTTP clients, databases, queues, providers, and merchant systems is not a realistic general assumption.

Design for effectively-once business behavior using:

- Idempotency keys.
- Unique constraints.
- Durable operation records.
- Transactional outbox.
- Deduplicated consumers.
- State-machine validation.
- Immutable ledger references.
- Reconciliation.

---

# 27. Final Design Summary

A reliable payment system can be understood through five central ideas.

## 27.1 Stable payment intent

Represent the merchant's payment goal as a stable payment object. Record each provider call as a separate attempt.

```text
Payment -> one logical business operation
Attempt -> one provider execution
```

## 27.2 Explicit state machine

Allow only valid payment transitions. Handle `PROCESSING` and unknown outcomes as normal states, not edge cases.

## 27.3 Idempotency at every boundary

Use durable idempotency for merchant requests, provider requests, events, ledger postings, and webhook deliveries.

## 27.4 Immutable financial ledger

Keep payment workflow state separate from accounting. Record every money movement as balanced, append-only ledger entries.

## 27.5 Reconciliation as the final safety net

Compare internal records against provider and bank records. Repair mismatches through audited correction workflows.

## 27.6 Compact architecture view

```mermaid
flowchart LR
    Merchant --> API[Payment API]
    API --> PaymentDB[(Payment DB)]
    API --> Risk[Risk]
    API --> Router[Provider Router]
    Router --> Providers[Payment Providers]
    API --> Ledger[Immutable Ledger]
    API --> Outbox[(Transactional Outbox)]
    Outbox --> Events[Event Broker]
    Providers --> Webhooks[Webhook Ingestion]
    Webhooks --> PaymentDB
    Events --> Notifications[Merchant Notifications]
    Providers --> Reconciliation[Reconciliation]
    PaymentDB --> Reconciliation
    Ledger --> Reconciliation
```

The most important interview-level conclusion is:

> A payment system is not just an API that calls a gateway. It is a distributed financial workflow that must safely handle duplicate requests, uncertain external outcomes, asynchronous events, immutable money records, and reconciliation.

---

# 28. References

The following official references are useful for validating production design details:

1. Stripe API — Idempotent requests:  
   https://docs.stripe.com/api/idempotent_requests

2. Stripe — PaymentIntent lifecycle:  
   https://docs.stripe.com/payments/paymentintents/lifecycle

3. Stripe — Webhook delivery and signature handling:  
   https://docs.stripe.com/webhooks

4. PCI Security Standards Council — PCI DSS:  
   https://www.pcisecuritystandards.org/standards/pci-dss/

5. AWS Prescriptive Guidance — Transactional outbox pattern:  
   https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

6. AWS Well-Architected Financial Services Industry Lens — Payments and reliability:  
   https://docs.aws.amazon.com/wellarchitected/latest/financial-services-industry-lens/payments.html

7. Apache Kafka documentation — Delivery and transaction semantics:  
   https://kafka.apache.org/documentation/

---

**End of document**
