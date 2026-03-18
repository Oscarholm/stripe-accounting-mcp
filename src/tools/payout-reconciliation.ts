import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry, getClient } from "../account-registry.js";
import { fetchAll, toMajor } from "../stripe-client.js";
import { parsePeriod, formatDate } from "../utils/dates.js";
import Stripe from "stripe";

interface PayoutSummary {
  id: string;
  arrival_date: string;
  amount: number;
  currency: string;
  status: string;
  gross_charges: number;
  refunds: number;
  stripe_fees: number;
  adjustments: number;
  net: number;
  transaction_count: number;
}

export function categorizeTransactions(transactions: Stripe.BalanceTransaction[]) {
  let grossCharges = 0;
  let refunds = 0;
  let stripeFees = 0;
  let adjustments = 0;

  for (const txn of transactions) {
    switch (txn.type) {
      case "charge":
      case "payment":
        grossCharges += toMajor(txn.amount);
        break;
      case "refund":
        refunds += toMajor(Math.abs(txn.amount));
        break;
      case "stripe_fee":
        stripeFees += toMajor(Math.abs(txn.amount));
        break;
      case "payout":
        // Skip the payout transaction itself
        break;
      default:
        adjustments += toMajor(txn.amount);
        break;
    }
    // Fees are embedded in each transaction
    if (txn.fee > 0) {
      stripeFees += toMajor(txn.fee);
    }
  }

  return { grossCharges, refunds, stripeFees, adjustments };
}

export function registerPayoutReconciliation(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "get_payout_reconciliation",
    {
      description: "List payouts for a period with breakdown of charges, fees, refunds per payout. Drives ERP journal entries to clear the Stripe receivable account.",
      inputSchema: {
        account: z.string().optional().describe("Account alias. Defaults to 'default'."),
        period: z.string().describe('Period to query, e.g. "february 2026", "last month"'),
        currency: z.string().optional().describe("Filter by currency."),
      },
    },
    async ({ account, period, currency }) => {
      const client = getClient(registry, account);
      const range = parsePeriod(period);

      const payouts = await fetchAll<Stripe.Payout>(
        (params) => client.payouts.list(params as Stripe.PayoutListParams),
        {
          arrival_date: { gte: range.gte, lte: range.lte },
          limit: 100,
        }
      );

      const filteredPayouts = currency
        ? payouts.filter(p => p.currency === currency.toLowerCase())
        : payouts;

      const payoutSummaries: PayoutSummary[] = [];
      const totals = { gross_charges: 0, refunds: 0, stripe_fees: 0, net_paid_out: 0 };

      for (const payout of filteredPayouts) {
        const transactions = await fetchAll<Stripe.BalanceTransaction>(
          (params) => client.balanceTransactions.list(params as Stripe.BalanceTransactionListParams),
          { payout: payout.id, limit: 100 }
        );

        const { grossCharges, refunds, stripeFees, adjustments } = categorizeTransactions(transactions);
        const net = grossCharges - refunds - stripeFees + adjustments;

        payoutSummaries.push({
          id: payout.id,
          arrival_date: formatDate(payout.arrival_date),
          amount: toMajor(payout.amount),
          currency: payout.currency,
          status: payout.status,
          gross_charges: grossCharges,
          refunds,
          stripe_fees: stripeFees,
          adjustments,
          net,
          transaction_count: transactions.length,
        });

        totals.gross_charges += grossCharges;
        totals.refunds += refunds;
        totals.stripe_fees += stripeFees;
        totals.net_paid_out += toMajor(payout.amount);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: account ?? "default",
            period: { from: formatDate(range.gte), to: formatDate(range.lte) },
            payouts: payoutSummaries,
            totals,
          }, null, 2),
        }],
      };
    }
  );
}
