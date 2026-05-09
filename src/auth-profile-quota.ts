export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MIN_REFRESH_DAYS = 1 / (24 * 60);

export function remainingPercent(usedPercent: unknown): number | undefined {
  const used = Number(usedPercent);
  if (!Number.isFinite(used)) {
    return undefined;
  }

  return Math.max(0, Math.min(100, 100 - used));
}

export function daysUntilReset(
  resetsAt: unknown,
  now: Date | number | string | undefined = undefined
): number | undefined {
  const resetSeconds = Number(resetsAt);
  if (!Number.isFinite(resetSeconds)) {
    return undefined;
  }

  const deltaDays = (resetSeconds * 1000 - timestampMs(now)) / MS_PER_DAY;
  return Math.max(deltaDays, MIN_REFRESH_DAYS);
}

export function weightedWeeklyQuotaScore(
  remaining: number | undefined,
  refreshDays: number | undefined
): number | undefined {
  if (remaining === undefined) {
    return undefined;
  }

  const days = refreshDays ?? 7;
  return (remaining / 100) / (days / 7);
}

export function formatWeeklyQuotaDisplay(options: {
  readonly usedPercent: unknown;
  readonly resetsAt?: unknown;
  readonly now?: Date | number | string | undefined;
}): string | null {
  const remaining = remainingPercent(options.usedPercent);
  if (remaining === undefined) {
    return null;
  }

  const score = weightedWeeklyQuotaScore(remaining, daysUntilReset(options.resetsAt, options.now));
  return `${Math.round(remaining)}% | ${formatWeightedWeeklyQuotaScore(score)}`;
}

export function formatWeightedWeeklyQuotaScore(score: number | undefined): string {
  if (!Number.isFinite(score)) {
    return "0";
  }

  return Number(score)
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

export function timestampMs(value: Date | number | string | undefined): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Date.now();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}
