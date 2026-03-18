import { useCallback, useEffect, useRef } from 'react';

/**
 * 비동기 작업의 무한 로딩 방지 타이머.
 * startGuard(setLoading, timeout)로 시작 → finally에서 clearGuard() 호출.
 * timeout 초과 시 setLoading(false) 자동 실행 + 콘솔 경고.
 */
export function useAsyncGuard() {
  const timerRef = useRef<number | null>(null);

  const startGuard = useCallback(
    (setLoading: (v: boolean) => void, timeoutMs = 30_000) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        console.warn(`[AsyncGuard] ${timeoutMs / 1000}초 타임아웃 — 강제 로딩 해제`);
        setLoading(false);
        timerRef.current = null;
      }, timeoutMs);
    },
    []
  );

  const clearGuard = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 언마운트 시 자동 정리
  useEffect(() => () => clearGuard(), [clearGuard]);

  return { startGuard, clearGuard };
}
