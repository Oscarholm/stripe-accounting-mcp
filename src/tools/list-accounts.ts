import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountRegistry } from "../account-registry.js";

export function registerListAccounts(server: McpServer, registry: AccountRegistry) {
  server.registerTool(
    "list_accounts",
    {
      description: "List all configured Stripe accounts. Call this first to discover available account aliases.",
    },
    async () => {
      const accounts = Array.from(registry.keys());
      const hasDefault = registry.has("default");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            accounts,
            default_account: hasDefault ? "default" : accounts[0],
          }, null, 2),
        }],
      };
    }
  );
}
