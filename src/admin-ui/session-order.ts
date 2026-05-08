export interface SessionOrderState {
  readonly viewKey: string;
  readonly keys: readonly string[];
}

export function stableSessionOrder(
  previous: SessionOrderState,
  viewKey: string,
  sortedKeys: readonly string[]
): SessionOrderState {
  if (previous.viewKey !== viewKey) {
    return { viewKey, keys: [...sortedKeys] };
  }

  const alive = new Set(sortedKeys);
  const kept = previous.keys.filter((key) => alive.has(key));
  const seen = new Set(kept);
  return {
    viewKey,
    keys: kept.concat(sortedKeys.filter((key) => !seen.has(key)))
  };
}
