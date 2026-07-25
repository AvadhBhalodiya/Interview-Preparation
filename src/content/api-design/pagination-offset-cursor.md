---
title: "Pagination"
group: "API Design"
order: 4
---

# Pagination: Offset-Based vs Cursor-Based

> Pagination breaks a large result set into bounded pages. Offset/limit is simple and lets you jump to any page but grows slow and drifts as the data changes underneath it, while cursor (keyset) pagination stays fast and stable by seeking past an opaque marker instead of counting rows to skip.

## What it is
Returning a big collection in bounded pages instead of one giant response. Any list endpoint that can grow needs it - an unbounded list is a latent outage waiting for the row count to catch up. Two families split the field:

- **Offset-based** skips N rows and takes the next slice: `?offset=40&limit=20`, or `?page=3`.
- **Cursor-based** (also **keyset** or **seek**) starts reading right after an opaque marker the previous page handed back: `?after=<cursor>`.

> [!KEY] The whole argument reduces to one difference: **offset makes the database count and discard rows**, while **a cursor makes it seek**. Speed, stability, and the loss of random page access all fall out of that.

How the two compare on what actually matters:

| Dimension | Offset / limit | Cursor / keyset |
| --- | --- | --- |
| Deep-page cost | **Degrades with depth** - reads and discards every skipped row | **Flat at any depth** - index seeks straight to the key |
| Stability under inserts/deletes | **Drifts** - an edit on an earlier page re-shows or skips rows | **Stable** - anchored to a value, not a position |
| Random access | **Jump to any page** ("page 7 of 50") | **Forward/back only** - no jump-to-page N |
| Total count | **Cheap-ish**, and often needed for page numbers anyway | **Full `COUNT(*)` scan** - the expensive part at scale |
| Cursor | Human-readable **integer** | **Opaque blob**, handed back untouched |

## Key points
- **Why deep offset is slow.** `OFFSET 10000` is not a cheap skip. The engine reads and discards all 10,000 rows before it reaches yours, so latency climbs with depth. Keyset turns that into `WHERE key > :cursor ORDER BY key LIMIT n`, an index seek that finds the start in roughly log(n) time no matter how deep you go.
- **Why offset drifts.** Offsets point at positions, not rows. Insert or delete something on an earlier page between two requests and every later row shifts by one, so the next page re-shows a record or jumps over one. A cursor is anchored to a value, so it does not move when its neighbors do.
- **The same pattern shows up in every protocol** - each replaced the numeric offset with an opaque forward marker for the same reasons:

| Protocol | Forward marker | End-of-data signal |
| --- | --- | --- |
| REST | `Link: <...>; rel="next"` header (**RFC 8288**) | **no `next` link** in the header |
| GraphQL | **Relay** connection: `edges` + `cursor`, args `first`/`after` | **`pageInfo.hasNextPage: false`** |
| gRPC / Google | `page_token` / `next_page_token` (**AIP-158**) | **empty `next_page_token`** |

- **Treat the cursor as opaque.** Both the Relay spec and AIP-158 are explicit: the client holds it as a blob and hands it back untouched. Keep the encoding (usually base64 of the sort key) an implementation detail so you can change it without a breaking API version.
- **Signal the end explicitly**, never make callers infer it from a short page. AIP-158 is strict here - an **empty `next_page_token`** is the *only* sanctioned way to say "end of collection". Relay uses `pageInfo.hasNextPage`.
- **Cap the page size, and clamp rather than reject.** AIP-158's rule: no `page_size` or `0` picks a default, over your max **silently coerces down to the max**, and only genuine garbage like a negative value earns a `400`.

> [!TIP] Cursor paging has no cheap total. AIP-158 makes `total_size` optional and lets it be an **estimate** - at scale, an approximate count (or none) beats running `COUNT(*)` on every request.

## Example
```http
GET /v1/orders?limit=20&after=eyJpZCI6MTUwfQ HTTP/1.1
Host: api.example.com

HTTP/1.1 200 OK
Content-Type: application/json
Link: </v1/orders?limit=20&after=eyJpZCI6MTcwfQ>; rel="next"

{
  "data": [ "... 20 orders, ids 151-170 ..." ],
  "page_info": { "has_next_page": true, "end_cursor": "eyJpZCI6MTcwfQ" }
}
```

```sql
-- the cursor is just the last sort key, base64'd:
--   eyJpZCI6MTUwfQ  ->  {"id":150}
-- so ?after=eyJpZCI6MTUwfQ runs a seek, not a skip:
SELECT * FROM orders
WHERE id > 150
ORDER BY id
LIMIT 20;              -- this page's end_cursor encodes {"id":170}

-- non-unique sort? carry the tiebreaker in the cursor and compare as a tuple:
--   cursor = {"created_at":"2026-07-01T10:00:00Z","id":150}
SELECT * FROM orders
WHERE (created_at, id) > ('2026-07-01T10:00:00Z', 150)
ORDER BY created_at, id
LIMIT 20;              -- wants a composite index on (created_at, id)
```

```graphql
# GraphQL: the Relay Connections spec standardizes the same shape.
# first/after paginate forward; last/before paginate backward.
query {
  orders(first: 20, after: "eyJpZCI6MTUwfQ") {
    edges {
      node { id total }
      cursor
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

## Interview Q&A
- **Offset vs cursor, in one breath?** Offset skips a row count, so it is simple, allows random page access, but slows down deep in and drifts under writes. Cursor seeks past the last key you saw, so latency is flat and the window is stable under writes, but there is no jump-to-page and the token is opaque.
- **Why is deep offset slow?** `OFFSET 100000` does not skip for free. The engine still reads and discards those 100k rows on every request before it reaches your 20. Keyset turns that into an index seek on `WHERE key > :cursor`, which finds the start in roughly log(n) time no matter how deep you are.
- **What actually causes page drift?** Offsets point at positions, not rows. Insert or delete something on an earlier page between two requests and every later row shifts by one, so the next offset page re-shows a record or jumps over one. A cursor is anchored to a value, so it does not move when the neighbors do.
- **When do you reach for cursor?** Large tables, infinite scroll, real-time feeds, and any public list API you expect to get hammered. Offset is fine for small or bounded sets, admin tables, and page-number UIs where a human genuinely clicks "page 7".
- **How do you paginate a non-unique sort like `created_at`?** Add a unique tiebreaker to both the sort and the cursor: `ORDER BY created_at, id`, with the cursor carrying both. Without it, rows sharing a timestamp straddle the page boundary and get skipped or duplicated.

## Gotchas
> [!WARN] **A non-unique sort silently breaks a cursor.** Rows sharing a `created_at` straddle the page boundary and get skipped or duplicated. Always add a unique tiebreaker to both the sort and the cursor - `ORDER BY created_at, id`, cursor carries both - so the seek is deterministic.

> [!WARN] **Cursors are not capabilities.** AIP-158 spells it out: a page token must not grant authorization. Re-run your access checks on every request, or a leaked cursor becomes a data leak.

- Deep `OFFSET` degrades with the **offset value, not the page size**. Page 5000 is slow even when you only ask for 20 rows.
- **Offset paging over moving data double-shows or skips rows.** If the feed changes while users read it, use a cursor.
- **Server-side cursors can expire.** AIP-158 allows expiring tokens after a few days rather than holding state forever. Decide the TTL up front and return a clean `400`, never a `500`, on a stale cursor.
- **Do not `400` on an oversized `page_size`.** Clamp it to your max instead. Erroring on "too many" is a classic API papercut.

## Revise next
- [Database indexing](../databases/indexing-btree.md) and keyset/seek queries (composite indexes for tiebreakers)
- GraphQL Relay connections and [DRF cursor pagination classes](../drf/pagination-filtering-throttling.md)
- [Rate limiting](rate-limiting.md)

*Reviewed against the GraphQL Cursor Connections spec, Google AIP-158, and RFC 8288 (Web Linking), July 2026.*
