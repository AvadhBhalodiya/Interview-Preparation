---
title: "Double-Entry Ledger"
group: "Money Movement"
order: 2
---

# Double-Entry Ledger

> A ledger stores money as immutable journal entries whose lines always sum to zero rather than as a mutable `balance` column, because the column answers "how much?" while destroying the far more valuable answer to "why?", and because an append-only design turns every correction into visible history instead of a silent `UPDATE`.

## What it is
Two tables carry the whole model. An **account** is a bucket money can sit in - a customer wallet, your settlement bank account, a fee account, a revenue account. A **journal entry** is one economic event, made of two or more **lines**, each naming an account and a signed amount. The rule that makes it double-entry: **the lines of an entry sum to exactly zero.** Money is never created or destroyed, only moved between accounts.

Accountants write this as debits and credits. As an engineer you can model it as **signed integers in minor units** and get the same invariant with less ceremony: a debit is positive, a credit is negative, and `SUM(amount) = 0` per entry.

A customer paying 500.00 INR for an order, with a 2 percent gateway fee, is one entry with three lines:

```text
entry #7741  "order 8412 captured"
  +50000  customer_receivable   (debit)
   -1000  gateway_fees          (credit)
  -49000  revenue               (credit)
  ------
       0  <- the invariant
```

> [!KEY] The `balance` column is not a performance optimisation of a ledger, it is a **lossy cache** of one. You can always derive a balance from entries; you can never derive entries from a balance. Store the thing you cannot recompute.

| Aspect | Mutable `balance` column | Double-entry ledger |
| --- | --- | --- |
| "Why is it 4,200?" | **Unanswerable** | Replay the entries |
| Concurrency | Lost update; needs a **row lock** on a hot row | **Append-only INSERTs**, no contention |
| Correcting a mistake | `UPDATE`, leaving **no trace** | A **reversal entry** - the error stays visible |
| Detecting corruption | Impossible - any number looks valid | `SUM(amount) <> 0` **fails loudly** |
| Read cost | **O(1)** | **O(n)** aggregate, needs snapshots |
| Audit / dispute | Nothing to show | The **entire history**, by construction |

## Key points
- **Balancing to zero is what makes bugs detectable.** A single-sided write ("credit the wallet 500") looks fine forever. In double entry that same bug fails a constraint at commit, because there is no matching source account. A nightly `SELECT entry_id FROM ledger_line GROUP BY entry_id HAVING SUM(amount) <> 0` should return zero rows; if it ever does not, you have a code path bypassing the ledger.
- **Append-only means no `UPDATE` and no `DELETE`, ever.** A wrong entry is corrected by posting a **reversal** - the same lines with opposite signs - and then the correct entry. You end up with three entries and a true story, instead of one entry and a lie. Enforce it with a `BEFORE UPDATE OR DELETE` trigger that raises, not with a code review convention.
- **Every movement needs a counter-account, including the ones that feel like thin air.** Money arriving from a card network comes *from* an asset account representing funds in transit at the PSP. Fees go *to* an expense account. Modelling these explicitly is what later makes [reconciliation](reconciliation.md) a subtraction rather than an investigation.
- **Store minor units as `bigint`, not floats.** 50000 paise, not `500.00` as a `float8`. Use `numeric(20, 8)` only where sub-minor precision genuinely exists - FX conversion, interest accrual, per-unit pricing - and round to minor units at the point where money actually moves, recording the rounding difference as its own line so the entry still balances.
- **Derive the balance, then snapshot it when the derivation gets slow.** `SUM(amount) WHERE account_id = ?` is correct from day one. When the account has millions of lines, write periodic snapshot rows (`account_id`, `as_of_entry_id`, `balance`) and compute the current balance as the snapshot plus the lines after it. The snapshot is a cache you can always rebuild - which is exactly what the `balance` column was not.
- **A balance check needs serialization; a plain posting does not.** Two concurrent withdrawals can both read a 100.00 balance and both post 80.00, taking the account to -60.00. Deriving the balance does not fix that - it is a write-skew, and it survives `READ COMMITTED`. Take a `SELECT ... FOR UPDATE` on the account row (or run the transaction at `SERIALIZABLE` and retry on failure) before any posting that must respect a limit.

> [!TIP] Give `ledger_entry` a `UNIQUE` external reference column and write the provider's charge id into it. Posting the ledger then inherits the same idempotency guarantee as the charge itself: a replayed webhook or a retried task hits the constraint instead of double-crediting.

## Example
```sql
CREATE TABLE ledger_entry (
    id           bigserial PRIMARY KEY,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    description  text        NOT NULL,
    -- Idempotency at the ledger layer: the same Stripe charge can only ever
    -- produce one entry, however many times the webhook is redelivered.
    external_ref text UNIQUE
);

CREATE TABLE ledger_line (
    id         bigserial PRIMARY KEY,
    entry_id   bigint  NOT NULL REFERENCES ledger_entry (id),
    account_id bigint  NOT NULL REFERENCES ledger_account (id),
    -- Minor units. Signed: debit positive, credit negative. Never zero, because
    -- a zero line is always a bug rather than a meaningful posting.
    amount     bigint  NOT NULL CHECK (amount <> 0),
    currency   char(3) NOT NULL
);

CREATE INDEX ledger_line_account_idx ON ledger_line (account_id, id);

-- The balance invariant cannot be a row-level CHECK, because it is only true
-- once ALL of an entry's lines exist. A DEFERRABLE constraint trigger moves
-- the check to COMMIT time, which is exactly when the entry is complete.
CREATE FUNCTION assert_entry_balances() RETURNS trigger AS $$
BEGIN
    IF (SELECT SUM(amount) FROM ledger_line WHERE entry_id = NEW.entry_id) <> 0 THEN
        RAISE EXCEPTION 'entry % does not balance', NEW.entry_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_line_balances
    AFTER INSERT ON ledger_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_entry_balances();

-- Immutability is a database guarantee, not a team agreement.
CREATE RULE ledger_line_no_update AS ON UPDATE TO ledger_line DO INSTEAD NOTHING;
CREATE RULE ledger_line_no_delete AS ON DELETE TO ledger_line DO INSTEAD NOTHING;
```

Posting from Django, with the limit check serialized and the whole entry atomic:

```python
@transaction.atomic
def post_entry(description: str, external_ref: str, lines: list[tuple[int, int]]) -> int:
    if sum(amount for _, amount in lines) != 0:
        raise ValueError("entry does not balance")   # fail before touching the DB

    # Lock the affected accounts in a stable order (by id) so two concurrent
    # transfers between the same pair cannot deadlock by grabbing them opposite ways.
    account_ids = sorted({acct for acct, _ in lines})
    LedgerAccount.objects.select_for_update().filter(id__in=account_ids)

    entry = LedgerEntry.objects.create(description=description, external_ref=external_ref)
    LedgerLine.objects.bulk_create([
        LedgerLine(entry=entry, account_id=acct, amount=amt, currency="INR")
        for acct, amt in lines
    ])
    # The deferred trigger runs at COMMIT. If a caller ever posts a half entry,
    # this raises and the whole transaction disappears - no partial money.
    return entry.id
```

## Interview Q&A
- **Why not just keep a `balance` column?** Because it answers one question and destroys every other one. You lose the history needed for disputes, audit, and reconciliation, and you turn every write into contention on a single hot row. Derive the balance from entries and snapshot it when the aggregate gets expensive.
- **What does "double entry" actually guarantee?** That every entry's lines sum to zero, so money always has a named source and a named destination. Its practical value is error detection: a single-sided write cannot be committed, and a full-ledger sum that drifts from zero proves something is bypassing the ledger.
- **How do you fix a wrong entry?** Post a reversal with the signs flipped, then post the correct entry. You never `UPDATE` or `DELETE`, because the audit trail is the product. The account ends up correct and the mistake stays visible, which is what an auditor or a regulator will ask to see.
- **Deriving a balance with `SUM` sounds slow. When does it break?** When an account accumulates enough lines that the aggregate stops being a cheap index scan. The fix is snapshot rows, current balance being the latest snapshot plus lines after it. Because snapshots are rebuildable from the entries, a bug in the snapshot job costs a recompute, not money.
- **Two withdrawals hit a wallet at once. What stops it going negative?** Not the ledger shape by itself - concurrent readers of a derived balance both see the old value, which is write skew and survives `READ COMMITTED`. Serialize the check with `SELECT ... FOR UPDATE` on the account row, or run at `SERIALIZABLE` and retry on serialization failure.
- **Where do gateway fees belong?** On their own line in the same entry, posted to an expense account. Netting the fee out of revenue makes the entry balance while quietly making the settlement figure unmatchable against the PSP's report later.

## Gotchas
> [!WARN] **A single-sided write is invisible until it is enormous.** Anywhere a code path credits a wallet without a matching debit - a promo credit, a manual adjustment from Django admin, a data migration - the ledger silently stops summing to zero. Make posting go through one function, block direct `INSERT` on `ledger_line` for the app role, and run the "entries that do not balance" query as a scheduled alert.

> [!WARN] **`float` for money is a correctness bug, not a rounding annoyance.** `0.1 + 0.2 != 0.3` in IEEE 754, and in a ledger that mismatch is a constraint violation or, worse, a paise that quietly vanishes on every transaction. Use `bigint` minor units, and where you must divide (splitting a payout, applying a percentage fee), assign the remainder to an explicit line rather than letting each part round independently.

- **Mixing currencies inside one entry.** An INR line and a USD line cannot sum to zero in any meaningful way. Keep entries single-currency and model an FX conversion as two entries joined through a dedicated FX position account, with the rate stored on the entry.
- **Using `created_at` as the accounting date.** The moment your row was inserted is not the moment the money moved, and after an outage or a delayed webhook they can differ by days. Store `occurred_at` (the economic event) separately from `created_at` (the row), and report on the former.
- **Deleting test entries in production.** Once the immutability rule is in place this fails, which is the point. Correct with a reversal so the count of entries never goes down.

## Revise next
- **[Reconciliation](reconciliation.md)**: proving your ledger matches the PSP and the bank, which only works if the ledger is complete.
- **[Isolation levels](../databases/transaction-isolation-levels.md)**: why the two-concurrent-withdrawals case is write skew and what `SERIALIZABLE` costs to fix it.
- **[Locking, optimistic vs pessimistic](../databases/locking-optimistic-pessimistic.md)**: choosing `SELECT ... FOR UPDATE` against a version-column retry for balance checks.
- **[Django transactions](../django/transactions-atomic.md)**: `atomic()` blocks, savepoints, and why the deferred constraint fires at commit rather than at `bulk_create`.

*Reviewed against PostgreSQL 18 (deferrable constraint triggers, `SELECT ... FOR UPDATE`) and Django 6.0 / 5.2 LTS, July 2026.*
