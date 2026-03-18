import Stripe from "stripe";

export async function fetchAll<T extends { id: string }>(
  listFn: (params: Stripe.PaginationParams) => Stripe.ApiListPromise<T>,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const results: T[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await listFn({
      limit: 100,
      ...params,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    } as Stripe.PaginationParams);

    results.push(...page.data);
    hasMore = page.has_more;
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1].id;
    }
  }

  return results;
}

export function toMajor(amount: number): number {
  return amount / 100;
}
