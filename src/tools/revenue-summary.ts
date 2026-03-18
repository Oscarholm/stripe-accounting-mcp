import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry, getClient } from "../account-registry.js";
import { fetchAll, toMajor } from "../stripe-client.js";
import { parsePeriod, formatDate } from "../utils/dates.js";
import Stripe from "stripe";

export function registerRevenueSummary(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "get_revenue_summary",
    {
      description: "Summarise all charges for a period — gross revenue, tax, refunds, and net. Used for posting to the Stripe receivable account in the ERP.",
      inputSchema: {
        account: z.string().optional().describe("Account alias. Defaults to 'default'."),
        period: z.string().describe('Period to query, e.g. "february 2026", "last month", "2026-02-01:2026-02-28"'),
        currency: z.string().optional().describe("Filter by currency (e.g. 'sek'). Returns all currencies if omitted."),
        include_refunds: z.boolean().optional().default(true).describe("Include refund data. Default: true."),
      },
    },
    async ({ account, period, currency, include_refunds }) => {
      const client = getClient(registry, account);
      const range = parsePeriod(period);

      // Fetch charges for the period
      const charges = await fetchAll<Stripe.Charge>(
        (params) => client.charges.list(params as Stripe.ChargeListParams),
        {
          created: { gte: range.gte, lte: range.lte },
          limit: 100,
        }
      );

      // Fetch invoices for tax enrichment — build map keyed by invoice ID
      const invoices = await fetchAll<Stripe.Invoice>(
        (params) => client.invoices.list(params as Stripe.InvoiceListParams),
        {
          created: { gte: range.gte, lte: range.lte },
          status: "paid",
          limit: 100,
        }
      );
      const invoiceMap = new Map<string, Stripe.Invoice>();
      for (const inv of invoices) {
        invoiceMap.set(inv.id, inv);
      }

      // Filter by currency if specified
      const filtered = currency
        ? charges.filter(c => c.currency === currency.toLowerCase())
        : charges;

      let grossRevenue = 0;
      let taxCollected = 0;
      let refunds = 0;
      let refundCount = 0;
      const chargeDetails = [];

      for (const charge of filtered) {
        if (charge.status !== "succeeded") continue;

        const amount = toMajor(charge.amount);
        const amountRefunded = toMajor(charge.amount_refunded);
        grossRevenue += amount;

        if (include_refunds && charge.amount_refunded > 0) {
          refunds += amountRefunded;
          refundCount++;
        }

        // Try to find tax from a matching invoice
        let tax = 0;
        let invoiceId: string | undefined;

        for (const [id, inv] of invoiceMap) {
          if (inv.amount_paid === charge.amount && Math.abs(inv.created - charge.created) < 60) {
            invoiceId = id;
            if (inv.total_excluding_tax !== null) {
              tax = toMajor(inv.total - inv.total_excluding_tax);
            }
            break;
          }
        }
        taxCollected += tax;

        chargeDetails.push({
          id: charge.id,
          created: formatDate(charge.created),
          amount,
          amount_refunded: amountRefunded,
          tax,
          description: charge.description ?? "",
          invoice_id: invoiceId,
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: account ?? "default",
            period: { from: formatDate(range.gte), to: formatDate(range.lte) },
            gross_revenue: grossRevenue,
            tax_collected: taxCollected,
            refunds,
            net_revenue: grossRevenue - refunds,
            transaction_count: chargeDetails.length,
            refund_count: refundCount,
            currency: currency ?? "all",
            charges: chargeDetails,
          }, null, 2),
        }],
      };
    }
  );
}
