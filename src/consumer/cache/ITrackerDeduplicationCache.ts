export interface ITrackerDeduplicationCache {
  has(key: string): Promise<boolean>;
  set(key: string, ttlMs: number): Promise<void>;
}
