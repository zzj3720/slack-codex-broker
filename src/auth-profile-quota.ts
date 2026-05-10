export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_MINUTE = 60 * 1000;
export const MIN_REFRESH_DAYS = 1 / (24 * 60);
export const DEFAULT_SHORT_WINDOW_MINS = 300;
export const DEFAULT_WEEKLY_WINDOW_MINS = 10_080;
export const SHORT_WINDOW_DISPLAY_SCORE_THRESHOLD = 0.5;

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

export function msUntilReset(
  resetsAt: unknown,
  now: Date | number | string | undefined = undefined
): number | undefined {
  const resetSeconds = Number(resetsAt);
  if (!Number.isFinite(resetSeconds)) {
    return undefined;
  }

  return Math.max(resetSeconds * 1000 - timestampMs(now), MS_PER_MINUTE);
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

export function weightedQuotaWindowScore(options: {
  readonly remaining: number | undefined;
  readonly resetsAt?: unknown;
  readonly windowDurationMins?: unknown;
  readonly fallbackWindowDurationMins: number;
  readonly now?: Date | number | string | undefined;
}): number | undefined {
  if (options.remaining === undefined) {
    return undefined;
  }

  const windowMins = normalizeWindowDurationMins(
    options.windowDurationMins,
    options.fallbackWindowDurationMins
  );
  const resetMs = msUntilReset(options.resetsAt, options.now) ?? windowMins * MS_PER_MINUTE;
  return (options.remaining / 100) / (resetMs / (windowMins * MS_PER_MINUTE));
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

export function formatQuotaWindowDisplay(options: {
  readonly usedPercent: unknown;
  readonly resetsAt?: unknown;
  readonly windowDurationMins?: unknown;
  readonly fallbackWindowDurationMins: number;
  readonly now?: Date | number | string | undefined;
}): string | null {
  const remaining = remainingPercent(options.usedPercent);
  if (remaining === undefined) {
    return null;
  }

  const windowMins = normalizeWindowDurationMins(
    options.windowDurationMins,
    options.fallbackWindowDurationMins
  );
  const score = weightedQuotaWindowScore({
    remaining,
    resetsAt: options.resetsAt,
    windowDurationMins: windowMins,
    fallbackWindowDurationMins: windowMins,
    now: options.now
  });
  return `${formatWindowDuration(windowMins)} ${Math.round(remaining)}% / ${formatWeightedWeeklyQuotaScore(score)}`;
}

export function formatAuthQuotaDisplay(options: {
  readonly primary?: {
    readonly usedPercent?: unknown;
    readonly resetsAt?: unknown;
    readonly windowDurationMins?: unknown;
  } | null | undefined;
  readonly secondary?: {
    readonly usedPercent?: unknown;
    readonly resetsAt?: unknown;
    readonly windowDurationMins?: unknown;
  } | null | undefined;
  readonly now?: Date | number | string | undefined;
}): string | null {
  const weekly = formatQuotaWindowDisplay({
    usedPercent: options.secondary?.usedPercent,
    resetsAt: options.secondary?.resetsAt,
    windowDurationMins: options.secondary?.windowDurationMins,
    fallbackWindowDurationMins: DEFAULT_WEEKLY_WINDOW_MINS,
    now: options.now
  });
  const short = shouldShowShortWindowQuota(options.primary, options.now)
    ? formatQuotaWindowDisplay({
        usedPercent: options.primary?.usedPercent,
        resetsAt: options.primary?.resetsAt,
        windowDurationMins: options.primary?.windowDurationMins,
        fallbackWindowDurationMins: DEFAULT_SHORT_WINDOW_MINS,
        now: options.now
      })
    : null;
  const parts = [weekly, short].filter(Boolean);
  return parts.length ? parts.join(" | ") : null;
}

export function shouldShowShortWindowQuota(
  limit: {
    readonly usedPercent?: unknown;
    readonly resetsAt?: unknown;
    readonly windowDurationMins?: unknown;
  } | null | undefined,
  now?: Date | number | string | undefined
): boolean {
  const remaining = remainingPercent(limit?.usedPercent);
  const score = weightedQuotaWindowScore({
    remaining,
    resetsAt: limit?.resetsAt,
    windowDurationMins: limit?.windowDurationMins,
    fallbackWindowDurationMins: DEFAULT_SHORT_WINDOW_MINS,
    now
  });
  return Number.isFinite(score) && Number(score) < SHORT_WINDOW_DISPLAY_SCORE_THRESHOLD;
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

function normalizeWindowDurationMins(value: unknown, fallback: number): number {
  const mins = Number(value);
  return Number.isFinite(mins) && mins > 0 ? mins : fallback;
}

function formatWindowDuration(windowMins: number): string {
  if (windowMins % (24 * 60) === 0) {
    return `${windowMins / (24 * 60)}d`;
  }
  if (windowMins % 60 === 0) {
    return `${windowMins / 60}h`;
  }
  return `${windowMins}m`;
}
