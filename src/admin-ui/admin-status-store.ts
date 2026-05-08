type Listener = () => void;

export interface AdminStatusSnapshot {
  readonly status: unknown;
  readonly version: number;
}

let snapshot: AdminStatusSnapshot = { status: null, version: 0 };
const listeners = new Set<Listener>();

export function publishAdminStatus(status: unknown): void {
  snapshot = { status, version: snapshot.version + 1 };
  listeners.forEach((listener) => listener());
}

export function subscribeAdminStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAdminStatusSnapshot(): AdminStatusSnapshot {
  return snapshot;
}
