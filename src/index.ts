import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRegistry } from "./account-registry.js";
import { registerListAccounts } from "./tools/list-accounts.js";
import { registerBalanceSummary } from "./tools/balance-summary.js";
import { registerRevenueSummary } from "./tools/revenue-summary.js";
import { registerPayoutReconciliation } from "./tools/payout-reconciliation.js";
import { registerPayoutDetail } from "./tools/payout-detail.js";

const registry = buildRegistry();

const server = new McpServer({
  name: "stripe-accounting",
  version: "1.0.0",
});

registerListAccounts(server, registry);
registerBalanceSummary(server, registry);
registerRevenueSummary(server, registry);
registerPayoutReconciliation(server, registry);
registerPayoutDetail(server, registry);

const transport = new StdioServerTransport();
await server.connect(transport);
