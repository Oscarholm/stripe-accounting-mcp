# Specification: `get_revenue_by_location` — Stripe MCP Tool

## Background

The existing `get_revenue_summary` tool returns a single aggregate revenue figure for a given period. For accounting purposes, revenue needs to be split by **Stripe Terminal location** so that it can be mapped to cost centers in the ERP. Each charge processed via a Stripe Terminal reader is associated with a `location_id`, which in turn has a human-readable `display_name` and `address`.

This document specifies a new MCP tool: `get_revenue_by_location`.

---

## Tool definition

**Name:** `get_revenue_by_location`

**Description:**
Summarise Stripe revenue for a period, grouped by Terminal location. Returns gross revenue, tax collected, refunds, and net revenue per location, plus an `unassigned` bucket for any charges not associated with a Terminal location (e.g. invoice payments, manual charges).

### Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `period` | string | Yes | Period to query, e.g. `"february 2026"`, `"last month"`, `"2026-02-01:2026-02-28"` |
| `account` | string | No | Account alias from `STRIPE_KEY_*` env vars. Defaults to `"default"` |
| `currency` | string | No | Filter by currency, e.g. `"sek"`. Returns all currencies if omitted |
| `include_refunds` | boolean | No | Include refund data. Default: `true` |

### Response shape

```json
{
  "account": "default",
  "period": {
    "from": "2026-02-01",
    "to": "2026-02-28"
  },
  "currency": "sek",
  "locations": [
    {
      "location_id": "tml_abc123",
      "display_name": "ODE 1",
      "city": "Stockholm",
      "gross_revenue": 150000.00,
      "tax_collected": 2400.00,
      "refunds": 0,
      "net_revenue": 150000.00,
      "transaction_count": 85
    },
    {
      "location_id": "tml_def456",
      "display_name": "GBG",
      "city": "Göteborg",
      "gross_revenue": 75000.00,
      "tax_collected": 1200.00,
      "refunds": 500.00,
      "net_revenue": 74500.00,
      "transaction_count": 42
    }
  ],
  "unassigned": {
    "gross_revenue": 50000.00,
    "tax_collected": 0,
    "refunds": 0,
    "net_revenue": 50000.00,
    "transaction_count": 12,
    "note": "Charges not associated with a Terminal location, e.g. invoice payments or API charges"
  },
  "totals": {
    "gross_revenue": 275000.00,
    "tax_collected": 3600.00,
    "refunds": 500.00,
    "net_revenue": 274500.00,
    "transaction_count": 139
  }
}
```

---

## Implementation notes

### How to fetch location data per charge

Beam (the clinic operations platform) explicitly writes the physical reader ID to the PaymentIntent metadata under the key **`TerminalId`** (e.g. `tmr_GW1QpgUdgGgtvP`). This is the primary and preferred way to resolve location. The lookup chain is:

```
PaymentIntent.metadata.TerminalId (tmr_...) → reader.location (tml_...) → location.display_name
```

Step by step:

1. **Build a reader → location map** at the start of each invocation by calling `GET /v1/terminal/readers` (returns all readers with their `location` field). Store as `{ tmr_id: tml_id }`.
2. **Build a location map** by calling `GET /v1/terminal/locations`. Store as `{ tml_id: { display_name, city } }`.
3. **List all charges** for the period using the Stripe API (`/v1/charges` with `created[gte]` and `created[lte]`), expanding `payment_intent` on each charge.
4. For each charge, read **`payment_intent.metadata.TerminalId`**. If present, resolve `tmr_id → tml_id → location` using the cached maps. No additional API calls needed per charge.
5. If `TerminalId` is absent (e.g. invoice payments, manual charges), assign to the `unassigned` bucket.

This approach is preferred over inferring location from `payment_method_details.card_present` because:
- It is **explicit** — Beam intentionally tags every Terminal charge
- It requires **no per-charge API calls** beyond the charge list itself
- It is **resilient** to changes in Stripe's payment method details structure

### Caching readers and locations
Both `GET /v1/terminal/readers` and `GET /v1/terminal/locations` should be called **once per tool invocation** and cached in memory for the duration of that call. There are typically few readers and locations (under 50), so a single call each is sufficient. Use pagination if the account grows.

### Handling the `unassigned` bucket
Charges that fall into `unassigned` are likely:
- Invoice payments (`py_` prefix charges)
- Manually created charges via the API or Dashboard
- Any charge where Beam did not write a `TerminalId` to metadata

These are common and expected — do not treat them as errors.

### Period parsing
Reuse the same period parsing logic as the existing `get_revenue_summary` tool for consistency (natural language like `"february 2026"` should resolve to the correct `from`/`to` dates).

### Pagination
Stripe's `/v1/charges` endpoint returns max 100 objects per page. Use cursor-based pagination (`starting_after`) to fetch all charges in the period before grouping.

---

## Consistency requirements

- The `totals` block in `get_revenue_by_location` **must equal** the output of `get_revenue_summary` for the same period and account. Add a note in the tool description advising callers to cross-check these if reconciliation is needed.
- `unassigned.gross_revenue + sum(locations[].gross_revenue)` must equal `totals.gross_revenue`.

---

## Optional future extension: `get_payout_reconciliation_by_location`

Once `get_revenue_by_location` is implemented, a natural follow-up is to also split payouts by location. This would allow per-location P&L matching. However, note that Stripe payouts are **not** split by location — a single payout covers all locations. The split would therefore be derived (not native), by apportioning each payout pro-rata by location revenue share, or by listing the underlying charges per payout (via `get_payout_detail`) and grouping those by location. Recommend deferring this until the basic location split is validated.
