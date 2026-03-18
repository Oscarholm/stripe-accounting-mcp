import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry, getClient } from "../account-registry.js";
import { toMajor } from "../stripe-client.js";

export function registerBalanceSummary(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "get_balance_summary",
    {
      description: "Get current Stripe balance (available and pending) by currency. Quick sanity check for month-end.",
      inputSchema: {
        account: z.string().optional().describe("Account alias from STRIPE_KEY_* env vars. Defaults to 'default'."),
      },
    },
    async ({ account }) => {
      const client = getClient(registry, account);
      const balance = await client.balance.retrieve();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            account: account ?? "default",
            available: balance.available.map(b => ({
              currency: b.currency,
              amount: toMajor(b.amount),
            })),
            pending: balance.pending.map(b => ({
              currency: b.currency,
              amount: toMajor(b.amount),
            })),
            as_of: new Date().toISOString(),
          }, null, 2),
        }],
      };
    }
  );
}
