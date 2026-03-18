import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry, getClient } from "../account-registry.js";
import { fetchAll, toMajor } from "../stripe-client.js";
import { parsePeriod, formatDate } from "../utils/dates.js";
import Stripe from "stripe";

interface LocationBucket {
  gross_revenue: number;
  tax_collected: number;
  refunds: number;
  net_revenue: number;
  transaction_count: number;
}

function emptyBucket(): LocationBucket {
  return { gross_revenue: 0, tax_collected: 0, refunds: 0, net_revenue: 0, transaction_count: 0 };
}

export function registerRevenueByLocation(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "get_revenue_by_location",
    {
      description: "Break down revenue by Stripe Terminal location for a period. Used for mapping revenue to cost centers in the ERP.",
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

      // Fetch reader map: tmr_id → tml_id
      const readers = await fetchAll<Stripe.Terminal.Reader>(
        (params) => client.terminal.readers.list(params as Stripe.Terminal.ReaderListParams),
        { limit: 100 }
      );
      const readerMap = new Map<string, string>();
      for (const reader of readers) {
        if (reader.location && typeof reader.location === "string") {
          readerMap.set(reader.id, reader.location);
        } else if (reader.location && typeof reader.location === "object") {
          readerMap.set(reader.id, (reader.location as Stripe.Terminal.Location).id);
        }
      }

      // Fetch location map: tml_id → { display_name, city }
      const locations = await fetchAll<Stripe.Terminal.Location>(
        (params) => client.terminal.locations.list(params as Stripe.Terminal.LocationListParams),
        { limit: 100 }
      );
      const locationMap = new Map<string, { display_name: string; city: string }>();
      for (const loc of locations) {
        locationMap.set(loc.id, {
          display_name: loc.display_name,
          city: loc.address?.city ?? "",
        });
      }

      // Fetch charges with expanded payment_intent for metadata access
      const charges = await fetchAll<Stripe.Charge>(
        (params) => client.charges.list(params as Stripe.ChargeListParams),
        {
          created: { gte: range.gte, lte: range.lte },
          limit: 100,
          expand: ["data.payment_intent"],
        }
      );

      // Fetch invoices for tax enrichment
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

      // Group charges by location
      const buckets = new Map<string, LocationBucket>(); // tml_id → bucket
      const unassigned = emptyBucket();

      for (const charge of filtered) {
        if (charge.status !== "succeeded") continue;

        const amount = toMajor(charge.amount);
        const amountRefunded = toMajor(charge.amount_refunded);

        // Find tax from matching invoice
        let tax = 0;
        for (const [, inv] of invoiceMap) {
          if (inv.amount_paid === charge.amount && Math.abs(inv.created - charge.created) < 60) {
            if (inv.total_excluding_tax !== null) {
              tax = toMajor(inv.total - inv.total_excluding_tax);
            }
            break;
          }
        }

        // Resolve location from payment_intent metadata
        const pi = charge.payment_intent;
        const terminalId = (pi && typeof pi === "object") ? (pi as Stripe.PaymentIntent).metadata?.TerminalId : undefined;

        let locationId: string | undefined;
        if (terminalId) {
          locationId = readerMap.get(terminalId);
        }

        const bucket = locationId ? (buckets.get(locationId) ?? emptyBucket()) : unassigned;
        if (locationId && !buckets.has(locationId)) {
          buckets.set(locationId, bucket);
        }

        bucket.gross_revenue += amount;
        bucket.tax_collected += tax;
        bucket.transaction_count++;

        if (include_refunds && charge.amount_refunded > 0) {
          bucket.refunds += amountRefunded;
        }

        bucket.net_revenue = bucket.gross_revenue - bucket.refunds;
      }

      // Build locations array
      const locationsArray = Array.from(buckets.entries()).map(([tml_id, bucket]) => {
        const details = locationMap.get(tml_id);
        return {
          location_id: tml_id,
          display_name: details?.display_name ?? "Unknown",
          city: details?.city ?? "",
          ...bucket,
        };
      });

      // Compute totals
      const totals = emptyBucket();
      for (const b of [...Array.from(buckets.values()), unassigned]) {
        totals.gross_revenue += b.gross_revenue;
        totals.tax_collected += b.tax_collected;
        totals.refunds += b.refunds;
        totals.transaction_count += b.transaction_count;
      }
      totals.net_revenue = totals.gross_revenue - totals.refunds;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: account ?? "default",
            period: { from: formatDate(range.gte), to: formatDate(range.lte) },
            currency: currency ?? "all",
            locations: locationsArray,
            unassigned,
            totals,
          }, null, 2),
        }],
      };
    }
  );
}
