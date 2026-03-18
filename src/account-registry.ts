import Stripe from "stripe";

export type AccountRegistry = Map<string, Stripe>;

export function buildRegistry(): AccountRegistry {
  const registry = new Map<string, Stripe>();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("STRIPE_KEY_") && value) {
      const alias = key.replace("STRIPE_KEY_", "").toLowerCase();
      registry.set(alias, new Stripe(value));
    }
  }
  if (registry.size === 0) {
    throw new Error("No STRIPE_KEY_* environment variables found");
  }
  return registry;
}

export function getClient(registry: AccountRegistry, account?: string): Stripe {
  const alias = account ?? "default";
  const client = registry.get(alias);
  if (!client) {
    const available = Array.from(registry.keys()).join(", ");
    throw new Error(`Unknown account "${alias}". Available accounts: ${available}`);
  }
  return client;
}
