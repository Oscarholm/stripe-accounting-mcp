# Stripe Accounting MCP — Implementation Plan

## Overview

A custom MCP server that exposes the Stripe data needed to support the full accounting workflow across multiple Stripe accounts. Each tool accepts an `account` parameter to select which account to query.

**Core workflow supported:**

1. **Revenue recognition** — fetch charges/invoices with amounts and tax, summarized for posting to the Stripe receivable account in the ERP
2. **Payout reconciliation** — fetch payouts and the associated fees/deductions, for clearing the receivable account and posting the net bank receipt

---

## Accounting Workflow This MCP Supports

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

Each MCP tool maps to one step in this workflow.

---

## Stack

- **Runtime:** Node.js (TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Stripe client:** `stripe` (official Node SDK)
- **Transport:** `stdio` (local, connect via Claude Desktop config)
- **Auth:** Multiple named API keys via environment variables (see below)

---

## Multi-Account Design

### Concept
Each Stripe account is identified by a short **account alias** (e.g. `"rethink_se"`, `"numbery"`). The alias maps to a secret key stored as an environment variable. Every tool accepts an `account` parameter — if omitted, the default account is used.

### Environment variable convention
```
STRIPE_KEY_RETHINK_SE=sk_live_...
STRIPE_KEY_NUMBERY=sk_live_...
STRIPE_KEY_DEFAULT=sk_live_...     # fallback when account param is omitted
```

The server reads all `STRIPE_KEY_*` vars at startup and builds an account registry. The alias is derived from the suffix: `STRIPE_KEY_RETHINK_SE` → alias `rethink_se`.

### Account registry (`src/account-registry.ts`)
```ts
type AccountRegistry = Map<string, Stripe>;  // alias → Stripe client instance

function buildRegistry(): AccountRegistry {
  const registry = new Map<string, Stripe>();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('STRIPE_KEY_') && value) {
      const alias = key.replace('STRIPE_KEY_', '').toLowerCase();
      registry.set(alias, new Stripe(value, { apiVersion: '2024-12-18.acacia' }));
    }
  }
  if (registry.size === 0) throw new Error('No STRIPE_KEY_* environment variables found');
  return registry;
}

function getClient(registry: AccountRegistry, account?: string): Stripe {
  const alias = account ?? 'default';
  const client = registry.get(alias);
  if (!client) {
    const available = Array.from(registry.keys()).join(', ');
    throw new Error(`Unknown account "${alias}". Available accounts: ${available}`);
  }
  return client;
}
```

### Tool 5 (bonus): `list_accounts`
A lightweight tool that returns all configured account aliases — so Claude (and you) can always discover what's available without checking config files.

```ts
// Input: none
// Output:
{
  accounts: string[];        // e.g. ["default", "rethink_se", "numbery"]
  default_account: string;   // the alias used when account param is omitted
}
```

---

## Project Structure

```
stripe-accounting-mcp/
├── src/
│   ├── index.ts                   # MCP server entrypoint, tool registration
│   ├── account-registry.ts        # Multi-account key management
│   ├── stripe-client.ts           # Pagination helper (account-agnostic)
│   ├── utils/
│   │   └── dates.ts               # Human-friendly date parsing → Unix timestamps
│   └── tools/
│       ├── list-accounts.ts       # Tool 5 — discover configured accounts
│       ├── revenue-summary.ts     # Tool 1
│       ├── payout-reconciliation.ts  # Tool 2
│       ├── payout-detail.ts       # Tool 3
│       └── balance-summary.ts     # Tool 4
├── package.json
├── tsconfig.json
└── .env                           # STRIPE_KEY_* vars (never committed)
```

---

## Tools

All tools (except `list_accounts`) share this common `account` parameter:

```ts
account?: string;  // alias from STRIPE_KEY_* env vars, e.g. "rethink_se". Defaults to "default".
```

If an unrecognised alias is passed, the tool returns a helpful error listing available accounts.

---

### Tool 1: `get_revenue_summary`

**Purpose:** Summarise all charges for a period — gross amount, tax, refunds, and net — ready for posting to the Stripe receivable account.

**Stripe APIs used:**
- `GET /v1/charges` — list succeeded charges in period
- `GET /v1/invoices` — optionally enrich with tax line items if using Stripe Invoicing/Tax

**Input parameters:**
```ts
{
  account?: string;
  period: string;             // e.g. "february 2026", "2026-02-01:2026-02-28"
  currency?: string;          // returns all currencies if omitted
  include_refunds?: boolean;  // default: true
}
```

**Output:**
```ts
{
  account: string;              // alias used
  period: { from: string; to: string };
  gross_revenue: number;
  tax_collected: number;        // from charge.tax or invoice tax lines
  refunds: number;
  net_revenue: number;          // gross - refunds
  transaction_count: number;
  refund_count: number;
  currency: string;
  charges: Array<{
    id: string;
    created: string;
    amount: number;
    amount_refunded: number;
    tax: number;
    description: string;
    invoice_id?: string;
  }>;
}
```

**Notes:**
- Must auto-paginate (Stripe max 100/page)
- Tax: check `charge.tax` first; fall back to fetching related invoice for `tax_amount_exclusive`
- Amounts returned in minor units from Stripe — convert to major units (e.g. SEK öre → kr) in output

---

### Tool 2: `get_payout_reconciliation`

**Purpose:** For a given period, list all payouts and for each payout show: gross charges included, Stripe fees deducted, refunds deducted, and net payout amount. This is the data needed to clear the receivable account and post the bank receipt.

**Stripe APIs used:**
- `GET /v1/payouts` — list payouts in period
- `GET /v1/balance_transactions?payout=po_xxx` — for each payout, get all constituent balance transactions

**Input parameters:**
```ts
{
  account?: string;
  period: string;         // e.g. "february 2026"
  currency?: string;
}
```

**Output:**
```ts
{
  account: string;
  period: { from: string; to: string };
  payouts: Array<{
    id: string;
    arrival_date: string;
    amount: number;           // net amount that hit bank
    currency: string;
    status: string;
    gross_charges: number;
    refunds: number;
    stripe_fees: number;
    adjustments: number;
    net: number;              // should equal amount
    transaction_count: number;
  }>;
  totals: {
    gross_charges: number;
    refunds: number;
    stripe_fees: number;
    net_paid_out: number;
  };
}
```

**Notes:**
- This is the most important tool for accounting — it directly drives the ERP journal entry to clear the receivable
- Balance transaction types to handle: `charge`, `refund`, `stripe_fee`, `adjustment`, `payout`
- Fee transactions have negative amounts in Stripe

---

### Tool 3: `get_payout_detail`

**Purpose:** Drill into a single payout — list every underlying transaction with its type, amount, and fee. Useful for reconciling individual discrepancies.

**Stripe APIs used:**
- `GET /v1/balance_transactions?payout=po_xxx&limit=100` (paginated)

**Input parameters:**
```ts
{
  account?: string;
  payout_id: string;      // e.g. "po_1ABC..."
}
```

**Output:**
```ts
{
  account: string;
  payout: {
    id: string;
    amount: number;
    arrival_date: string;
    currency: string;
    status: string;
  };
  transactions: Array<{
    id: string;
    type: string;           // "charge" | "refund" | "stripe_fee" | etc.
    created: string;
    amount: number;
    fee: number;
    net: number;
    description: string;
    source_id: string;      // e.g. ch_xxx or re_xxx
  }>;
  summary: {
    charges: number;
    refunds: number;
    fees: number;
    net: number;
  };
}
```

---

### Tool 4: `get_balance_summary`

**Purpose:** Current Stripe balance — available and pending, by currency. Quick sanity check and useful for month-end.

**Stripe APIs used:**
- `GET /v1/balance`

**Input parameters:**
```ts
{
  account?: string;
}
```

**Output:**
```ts
{
  account: string;
  available: Array<{ currency: string; amount: number }>;
  pending: Array<{ currency: string; amount: number }>;
  as_of: string;
}
```

---

### Tool 5: `list_accounts`

**Purpose:** List all Stripe accounts configured in this MCP instance. Useful for discovery — Claude can call this first to know which aliases are valid before calling any other tool.

**Input parameters:** none

**Output:**
```ts
{
  accounts: string[];        // e.g. ["default", "rethink_se", "numbery"]
  default_account: string;
}
```

---

## Key Implementation Details

### Date parsing (`utils/dates.ts`)
Accept human-friendly strings and resolve to `{ gte: number, lte: number }` Unix timestamps:
- `"february 2026"` → `{ gte: 1738368000, lte: 1740787199 }`
- `"2026-02-01:2026-02-28"` → explicit range
- `"last month"` → auto-resolved relative to now

### Auto-pagination helper (`stripe-client.ts`)
Account-agnostic — receives a pre-instantiated Stripe client from the registry:
```ts
async function fetchAll<T>(
  client: Stripe,
  fn: (stripe: Stripe, params: any) => Promise<Stripe.ApiList<T>>,
  params: any
): Promise<T[]>
```
Handles `has_more` + `starting_after` cursor pattern used across all Stripe list endpoints.

### Amount formatting
All Stripe amounts are in minor units (öre for SEK). The tools return amounts in major units as floats, labelled with currency.

### Error handling
- Unknown account alias → error listing available aliases
- Stripe API error → surface the Stripe error message directly (they're descriptive)
- Missing required env vars → fail at startup with clear message, not at call time

---

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

Add or remove `STRIPE_KEY_*` entries freely — the server picks them all up at startup with no code changes needed.

---

## Setup & Build

```bash
npm init -y
npm install @modelcontextprotocol/sdk stripe dotenv
npm install -D typescript @types/node ts-node

# tsconfig: target ES2020, module CommonJS, outDir ./dist
npx tsc

# Run locally for testing
node dist/index.js
```

---

## Implementation Order

1. **Scaffold** — `index.ts` + `account-registry.ts` + `stripe-client.ts` + date utils + MCP boilerplate
2. **Tool 5** (`list_accounts`) — zero API calls, instant validation of account registry logic
3. **Tool 4** (`get_balance_summary`) — simplest live API call, good per-account smoke test
4. **Tool 1** (`get_revenue_summary`) — core revenue data, drives ERP receivable posting
5. **Tool 2** (`get_payout_reconciliation`) — most complex, drives ERP clearing entries
6. **Tool 3** (`get_payout_detail`) — drill-down, reuses balance_transactions logic from Tool 2

---

## Future Extensions (out of scope for v1)

- `get_tax_report` — dedicated VAT/tax summary by rate, useful if using Stripe Tax
- `get_dispute_summary` — list chargebacks in period
- Webhook to auto-trigger monthly summary generation
- Cross-account summary — call `get_revenue_summary` across all accounts and aggregate
