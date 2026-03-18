# Stripe Accounting MCP

A custom MCP server that exposes Stripe data needed to support the full accounting workflow across multiple Stripe accounts. Each tool accepts an `account` parameter to select which account to query.

## Accounting Workflow

```
Stripe charges (gross revenue + tax)
        │
        ▼
[ERP: Debit Stripe Receivable A/C]
        │
        ├── Stripe processing fees (deducted)
        ├── Refunds (deducted)
        └── Net payout → bank account
        │
        ▼
[ERP: Credit Stripe Receivable A/C → Debit Bank A/C]
```

## Stack

- **Runtime:** Node.js (TypeScript, ESM)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Stripe client:** `stripe` (official Node SDK)
- **Transport:** `stdio` (connect via Claude Desktop config)

## Multi-Account Setup

Each Stripe account is identified by a short alias (e.g. `rethink_se`, `numbery`). The alias maps to a secret key stored as an environment variable:

```
STRIPE_KEY_RETHINK_SE=sk_live_...
STRIPE_KEY_NUMBERY=sk_live_...
STRIPE_KEY_DEFAULT=sk_live_...     # fallback when account param is omitted
```

The server reads all `STRIPE_KEY_*` vars at startup. The alias is derived from the suffix: `STRIPE_KEY_RETHINK_SE` → `rethink_se`. Add or remove entries freely — no code changes needed.

## Tools

All tools (except `list_accounts`) accept an optional `account` parameter (alias from `STRIPE_KEY_*` env vars). Defaults to `default` if omitted.

### `list_accounts`

List all configured Stripe account aliases. Useful for discovery before calling other tools.

### `get_revenue_summary`

Summarise all charges for a period — gross amount, tax, refunds, and net — ready for posting to the Stripe receivable account.

**Parameters:** `account?`, `period` (e.g. `"february 2026"`, `"2026-02-01:2026-02-28"`), `currency?`, `include_refunds?`

### `get_revenue_by_location`

Break down revenue by customer location/country for a given period. Useful for tax reporting and geographic revenue analysis.

**Parameters:** `account?`, `period`, `currency?`

### `get_payout_reconciliation`

For a given period, list all payouts with gross charges, Stripe fees, refunds, and net payout amount. This drives the ERP journal entry to clear the receivable.

**Parameters:** `account?`, `period`, `currency?`

### `get_payout_detail`

Drill into a single payout — every underlying transaction with type, amount, and fee. Useful for reconciling individual discrepancies.

**Parameters:** `account?`, `payout_id`

### `get_balance_summary`

Current Stripe balance — available and pending, by currency. Quick sanity check useful for month-end.

**Parameters:** `account?`

## Project Structure

```
stripe-accounting-mcp/
├── src/
│   ├── index.ts                      # MCP server entrypoint, tool registration
│   ├── account-registry.ts           # Multi-account key management
│   ├── stripe-client.ts              # Pagination helper
│   ├── utils/
│   │   └── dates.ts                  # Human-friendly date parsing → Unix timestamps
│   └── tools/
│       ├── list-accounts.ts
│       ├── balance-summary.ts
│       ├── revenue-summary.ts
│       ├── revenue-by-location.ts
│       ├── payout-reconciliation.ts
│       └── payout-detail.ts
├── package.json
├── tsconfig.json
└── .env                              # STRIPE_KEY_* vars (never committed)
```

## Setup

```bash
npm install
npm run build
```

## Claude Desktop Configuration

```json
{
  "mcpServers": {
    "stripe-accounting": {
      "command": "node",
      "args": ["/absolute/path/to/stripe-accounting-mcp/dist/index.js"],
      "env": {
        "STRIPE_KEY_DEFAULT": "sk_live_...",
        "STRIPE_KEY_RETHINK_SE": "sk_live_...",
        "STRIPE_KEY_NUMBERY": "sk_live_..."
      }
    }
  }
}
```
