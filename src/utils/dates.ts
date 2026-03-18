const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export interface DateRange {
  gte: number;
  lte: number;
}

export function parsePeriod(period: string): DateRange {
  const trimmed = period.trim().toLowerCase();

  // Explicit range: "2026-02-01:2026-02-28"
  if (trimmed.includes(":")) {
    const [fromStr, toStr] = trimmed.split(":");
    const from = new Date(fromStr.trim() + "T00:00:00");
    const to = new Date(toStr.trim() + "T23:59:59");
    return { gte: Math.floor(from.getTime() / 1000), lte: Math.floor(to.getTime() / 1000) };
  }

  // Relative: "last month", "this month"
  if (trimmed === "last month") {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { gte: Math.floor(first.getTime() / 1000), lte: Math.floor(last.getTime() / 1000) };
  }

  if (trimmed === "this month") {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { gte: Math.floor(first.getTime() / 1000), lte: Math.floor(last.getTime() / 1000) };
  }

  // "february 2026" or "feb 2026"
  const monthYearMatch = trimmed.match(/^(\w+)\s+(\d{4})$/);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1];
    const year = parseInt(monthYearMatch[2]);
    const monthIndex = MONTHS[monthName] ?? MONTHS[Object.keys(MONTHS).find(m => m.startsWith(monthName)) ?? ""];
    if (monthIndex !== undefined) {
      const first = new Date(year, monthIndex, 1);
      const last = new Date(year, monthIndex + 1, 0, 23, 59, 59);
      return { gte: Math.floor(first.getTime() / 1000), lte: Math.floor(last.getTime() / 1000) };
    }
  }

  throw new Error(
    `Cannot parse period "${period}". Use formats like "february 2026", "last month", or "2026-02-01:2026-02-28".`
  );
}

export function formatDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toISOString().split("T")[0];
}
