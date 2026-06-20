// Minimal KV abstraction for short-lived auxiliary caches (ENS, eth-labels).
// Backend selected by CACHE_BACKEND env var: "kv" → Deno KV (persistent),
// anything else → in-process memory map (default; safe for tests + single
// process deployments without shared state concerns).

export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

class MemoryKv implements KvStore {
  private readonly store = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }
}

class DenoKvStore implements KvStore {
  constructor(private readonly kv: Deno.Kv) {}

  async get<T>(key: string): Promise<T | null> {
    const entry = await this.kv.get<T>([key]);
    return entry.value ?? null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.kv.set([key], value, { expireIn: ttlMs });
  }
}

let _instance: KvStore | null = null;

export async function getKv(): Promise<KvStore> {
  if (_instance) return _instance;
  if (Deno.env.get("CACHE_BACKEND") === "kv") {
    const kv = await Deno.openKv();
    _instance = new DenoKvStore(kv);
  } else {
    _instance = new MemoryKv();
  }
  return _instance;
}

// Inject a fresh store, e.g. in unit tests that need isolation.
export function _overrideKvForTests(store: KvStore | null): void {
  _instance = store;
}

// Create a fresh isolated in-memory store. Pass as `cache:` in test opts
// so each test starts with an empty cache and doesn't share the singleton.
export function newMemoryKv(): KvStore {
  return new MemoryKv();
}
