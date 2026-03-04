import { useCallback, useEffect, useRef } from 'react';

/**
 * 컴포넌트 언마운트 여부를 추적하는 훅.
 * 비동기 작업 완료 후 isStale() 체크로 setState 호출을 방지한다.
 */
export function useStaleGuard(): () => boolean {
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  return useCallback(() => unmountedRef.current, []);
}
