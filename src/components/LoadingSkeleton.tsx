/**
 * 데이터 로딩 중 표시할 스켈레톤 컴포넌트.
 * "불러오는 중..." 전체 화면 차단 대신, 페이지 구조를 유지하면서
 * 데이터 영역만 펄스 애니메이션으로 표시한다.
 */

/** 테이블 형태의 스켈레톤 (목록 페이지용) */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-3 py-4">
      {/* 헤더 행 */}
      <div className="flex gap-4 pb-2 border-b border-gray-100">
        <div className="h-3 bg-gray-200 rounded w-1/4" />
        <div className="h-3 bg-gray-200 rounded w-16" />
        <div className="h-3 bg-gray-200 rounded w-16" />
        <div className="h-3 bg-gray-200 rounded w-12" />
      </div>
      {/* 데이터 행 */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 items-center">
          <div className="h-4 bg-gray-200 rounded flex-1" />
          <div className="h-4 bg-gray-200 rounded w-20" />
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-100 rounded w-12" />
        </div>
      ))}
    </div>
  );
}

/** 카드 형태의 스켈레톤 (대시보드용) */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-pulse bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <div className="flex justify-between items-center">
            <div className="h-4 bg-gray-200 rounded w-24" />
            <div className="h-6 w-6 bg-gray-100 rounded" />
          </div>
          <div className="h-3 bg-gray-100 rounded w-3/4" />
          <div className="h-3 bg-gray-100 rounded w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** 2컬럼 레이아웃 스켈레톤 (발송확인/입고확인 등) */
export function TwoColumnSkeleton() {
  return (
    <div className="animate-pulse grid grid-cols-1 md:grid-cols-2 gap-4">
      {[0, 1].map((col) => (
        <div key={col} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <div className="h-5 bg-gray-200 rounded w-20 mb-4" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex justify-between items-center py-1">
              <div className="h-4 bg-gray-200 rounded flex-1 mr-4" />
              <div className="h-4 bg-gray-100 rounded w-12" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
