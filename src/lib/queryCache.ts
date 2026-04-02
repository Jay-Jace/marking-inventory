/**
 * 간단한 인메모리 캐시 — 페이지 이동 시 이전 데이터를 즉시 보여주고 백그라운드에서 갱신
 * TTL: 30초 (30초 이내 재방문 시 캐시 사용)
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL = 30_000; // 30초

export function getCached<T>(key: string, ttlMs = DEFAULT_TTL): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

export function clearCache(keyPrefix?: string): void {
  if (!keyPrefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(keyPrefix)) cache.delete(key);
  }
}

/**
 * 캐시 우선 조회 — 캐시 있으면 즉시 반환 + 백그라운드 갱신
 * @param key 캐시 키
 * @param fetcher 데이터 조회 함수
 * @param onUpdate 백그라운드 갱신 완료 시 콜백
 * @param ttlMs 캐시 유효 시간 (기본 30초)
 */
export async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  onUpdate?: (data: T) => void,
  ttlMs = DEFAULT_TTL,
): Promise<T> {
  const cached = getCached<T>(key, ttlMs);

  if (cached) {
    // 캐시 있으면 즉시 반환 + 백그라운드 갱신
    fetcher().then((fresh) => {
      setCache(key, fresh);
      onUpdate?.(fresh);
    }).catch(() => {}); // 백그라운드 갱신 실패 무시
    return cached;
  }

  // 캐시 없으면 직접 조회
  const data = await fetcher();
  setCache(key, data);
  return data;
}
