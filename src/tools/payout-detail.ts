import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry, getClient } from "../account-registry.js";
import { fetchAll, toMajor } from "../stripe-client.js";
import { formatDate } from "../utils/dates.js";
import { categorizeTransactions } from "./payout-reconciliation.js";
import Stripe from "stripe";

export function registerPayoutDetail(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "get_payout_detail",
    {
      description: "Drill into a single payout — list every underlying transaction with type, amount, and fee. Useful for reconciling individual discrepancies.",
      inputSchema: {
        account: z.string().optional().describe("Account alias. Defaults to 'default'."),
        payout_id: z.string().describe('Payout ID, e.g. "po_1ABC..."'),
      },
    },
    async ({ account, payout_id }) => {
      const client = getClient(registry, account);

      const payout = await client.payouts.retrieve(payout_id);

      const transactions = await fetchAll<Stripe.BalanceTransaction>(
        (params) => client.balanceTransactions.list(params as Stripe.BalanceTransactionListParams),
        { payout: payout_id, limit: 100 }
      );

      const { grossCharges, refunds, stripeFees } = categorizeTransactions(transactions);

      const txnDetails = transactions
        .filter(txn => txn.type !== "payout")
        .map(txn => ({
          id: txn.id,
          type: txn.type,
          created: formatDate(txn.created),
          amount: toMajor(txn.amount),
          fee: toMajor(txn.fee),
          net: toMajor(txn.net),
          description: txn.description ?? "",
          source_id: typeof txn.source === "string" ? txn.source : (txn.source?.id ?? ""),
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: account ?? "default",
            payout: {
              id: payout.id,
              amount: toMajor(payout.amount),
              arrival_date: formatDate(payout.arrival_date),
              currency: payout.currency,
              status: payout.status,
            },
            transactions: txnDetails,
            summary: {
              charges: grossCharges,
              refunds,
              fees: stripeFees,
              net: grossCharges - refunds - stripeFees,
            },
          }, null, 2),
        }],
      };
    }
  );
}
