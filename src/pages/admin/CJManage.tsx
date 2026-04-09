import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouses } from '../../lib/warehouseStore';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import { recordTransactionBatch, validateTransactionBatch, deleteCjTransactions, countCjTransactions } from '../../lib/inventoryTransaction';
import type { ValidationError } from '../../lib/inventoryTransaction';
import { parseCjShipment, parseCjReceipt, parseCjReturn, detectCjFileType } from '../../lib/cjExcelParser';
import type { CjTransaction } from '../../lib/cjExcelParser';
import type { TxType } from '../../types';
import * as XLSX from 'xlsx';
import { Upload, X, AlertTriangle, CheckCircle, SkipForward, FileUp, Trash2 } from 'lucide-react';

export default function CJManage() {
  // CJ 엑셀 업로드
  const [uploadType, setUploadType] = useState<TxType | null>(null);
  const [parsedItems, setParsedItems] = useState<CjTransaction[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);

  // CJ 업로드 현황
  const [cjStatus, setCjStatus] = useState<Record<string, { maxDate: string; minDate: string; count: number }>>({});

  // CJ 삭제 모달
  const [deleteModal, setDeleteModal] = useState<{ type: TxType; minDate: string; maxDate: string } | null>(null);
  const [deleteStartDate, setDeleteStartDate] = useState('');
  const [deleteEndDate, setDeleteEndDate] = useState('');
  const [deletePreviewCount, setDeletePreviewCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // loading/error (useLoadingTimeout 인터페이스용 더미)
  const [loading, setLoading] = useState(false);
  const [, setError] = useState<string | null>(null);
  useLoadingTimeout(loading, setLoading, setError, 30_000);

  // 창고 목록
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    getWarehouses().then((list) => setWarehouses(list));
  }, []);

  // CJ 업로드 현황 조회
  const fetchCjStatus = useCallback(async () => {
    const cjWh = warehouses.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
    if (!cjWh) return;
    try {
      const allRows: { tx_type: string; tx_date: string }[] = [];
      let offset = 0;
      while (true) {
        const { data } = await supabase
          .from('inventory_transaction')
          .select('tx_type, tx_date')
          .eq('source', 'cj_excel')
          .eq('warehouse_id', cjWh.id)
          .range(offset, offset + 999);
        if (!data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < 1000) break;
        offset += 1000;
      }
      const status: Record<string, { maxDate: string; minDate: string; count: number }> = {};
      for (const row of allRows) {
        const type = row.tx_type as string;
        if (!status[type]) status[type] = { maxDate: '', minDate: '9999-99-99', count: 0 };
        status[type].count++;
        if (row.tx_date > status[type].maxDate) status[type].maxDate = row.tx_date;
        if (row.tx_date < status[type].minDate) status[type].minDate = row.tx_date;
      }
      setCjStatus(status);
    } catch (err) {
      console.error('fetchCjStatus error:', err);
    }
  }, [warehouses]);

  useEffect(() => {
    if (warehouses.length > 0) fetchCjStatus();
  }, [fetchCjStatus, warehouses]);

  // CJ 창고 조회 헬퍼
  const findCjWarehouse = async () => {
    let wh = warehouses.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
    if (!wh) {
      const list = await getWarehouses();
      setWarehouses(list);
      wh = list.find((w) => w.name.includes('CJ') || w.name.includes('cj'));
    }
    return wh || null;
  };

  // CJ 엑셀 파일 하나를 파싱 + 중복 제거
  const parseAndDedup = async (file: File, forceType: TxType | null): Promise<{
    items: CjTransaction[];
    skipped: number;
    type: TxType;
    overlapMsg: string | null;
  } | null> => {
    const detected = detectCjFileType(file.name);
    const type = forceType || detected;
    if (!type) return null;

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf);

    let allItems: CjTransaction[] = [];
    switch (type) {
      case '출고': allItems = parseCjShipment(wb); break;
      case '입고': allItems = parseCjReceipt(wb); break;
      case '반품': allItems = parseCjReturn(wb); break;
    }

    const cjWh = await findCjWarehouse();
    let newItems = allItems;
    let skipped = 0;
    let overlapMsg: string | null = null;

    if (cjWh) {
      const typesToCheck = type === '출고' ? ['출고', '판매'] : [type];
      const existingRefNos = new Set<string>();

      for (const t of typesToCheck) {
        const { data: existingTx } = await supabase
          .from('inventory_transaction')
          .select('memo')
          .eq('source', 'cj_excel')
          .eq('warehouse_id', cjWh.id)
          .eq('tx_type', t);

        for (const tx of existingTx || []) {
          if (tx.memo?.startsWith('CJ:')) {
            const refNo = tx.memo.split(':')[2];
            if (refNo) existingRefNos.add(refNo);
          }
        }
      }

      if (existingRefNos.size > 0) {
        newItems = allItems.filter((item) => !item.refNo || !existingRefNos.has(item.refNo));
        skipped = allItems.length - newItems.length;
      }

      if (newItems.length > 0) {
        const dates = newItems.map((i) => i.date).filter(Boolean).sort();
        const minDate = dates[0];
        const maxDate = dates[dates.length - 1];
        if (minDate && maxDate) {
          let totalOverlap = 0;
          for (const t of typesToCheck) {
            const { count } = await supabase
              .from('inventory_transaction')
              .select('*', { count: 'exact', head: true })
              .eq('source', 'cj_excel')
              .eq('warehouse_id', cjWh.id)
              .eq('tx_type', t)
              .gte('tx_date', minDate)
              .lte('tx_date', maxDate);
            totalOverlap += count || 0;
          }
          if (totalOverlap > 0 && skipped === 0) {
            overlapMsg = `${minDate} ~ ${maxDate} 기간에 이미 출고/판매 데이터 ${totalOverlap}건이 있습니다.`;
          }
        }
      }
    }

    return { items: newItems, skipped, type, overlapMsg };
  };

  // 유형별 단일 파일 업로드
  const handleSingleUpload = async (e: React.ChangeEvent<HTMLInputElement>, forceType: TxType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const result = await parseAndDedup(file, forceType);
    if (!result) return;

    setUploadType(result.type);
    setParsedItems(result.items);
    setSkippedCount(result.skipped);
    setOverlapWarning(result.overlapMsg);
    setUploadResult(null);
  };

  // 일괄 업로드 (multiple 파일)
  const handleBatchUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = '';

    let allItems: CjTransaction[] = [];
    let totalSkipped = 0;
    const overlapMsgs: string[] = [];
    const failedFiles: string[] = [];

    for (const file of Array.from(files)) {
      const result = await parseAndDedup(file, null);
      if (!result) {
        failedFiles.push(file.name);
        continue;
      }
      allItems = allItems.concat(result.items);
      totalSkipped += result.skipped;
      if (result.overlapMsg) overlapMsgs.push(result.overlapMsg);
    }

    if (failedFiles.length > 0) {
      setOverlapWarning(`파일명으로 유형 감지 실패: ${failedFiles.join(', ')}. 유형별 버튼을 사용해주세요.`);
    } else {
      setOverlapWarning(overlapMsgs.length > 0 ? overlapMsgs.join(' / ') : null);
    }

    const types = [...new Set(allItems.map((i) => i.type))];
    setUploadType(types.length === 1 ? types[0] : null);
    setParsedItems(allItems);
    setSkippedCount(totalSkipped);
    setUploadResult(null);
  };

  const handleSaveTx = async () => {
    if (parsedItems.length === 0) return;
    setUploading(true);
    setUploadProgress(null);
    setValidationErrors([]);

    const cjWarehouse = await findCjWarehouse();
    if (!cjWarehouse) {
      setUploadResult('CJ 창고를 찾을 수 없습니다.');
      setUploading(false);
      return;
    }

    const txRows = parsedItems.map((item) => ({
      warehouseId: cjWarehouse.id,
      skuId: item.skuId,
      txType: item.type,
      quantity: item.quantity,
      source: 'cj_excel' as const,
      txDate: item.date,
      memo: item.refNo ? `CJ:${item.type}:${item.refNo}` : `CJ 엑셀 업로드 (${item.type})`,
    }));

    const skuNameMap = new Map(parsedItems.map((item) => [item.skuId, item.skuName]));

    setUploadResult('검증 중... SKU 확인');
    const validation = await validateTransactionBatch(txRows, skuNameMap);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      setUploadResult(null);
      setUploading(false);
      return;
    }

    setUploadResult('저장 중...');
    setUploadProgress({ current: 0, total: txRows.length });
    const result = await recordTransactionBatch(txRows, skuNameMap, (current, total) => {
      setUploadProgress({ current, total });
    });
    setUploadProgress(null);
    setUploadResult(`저장 완료: ${result.success}건 성공${result.failed > 0 ? `, ${result.failed}건 실패` : ''}${skippedCount > 0 ? ` (중복 ${skippedCount}건 자동 제외)` : ''}`);
    setUploading(false);
    setParsedItems([]);
    setSkippedCount(0);
    setOverlapWarning(null);
    setUploadType(null);
    fetchCjStatus();
  };

  // CJ 데이터 삭제 모달 열기
  const openDeleteModal = (type: TxType, minDate: string, maxDate: string) => {
    setDeleteModal({ type, minDate, maxDate });
    setDeleteStartDate(minDate);
    setDeleteEndDate(maxDate);
    setDeletePreviewCount(null);
    setDeleteConfirm(false);
    handleDeletePreview(type, minDate, maxDate);
  };

  // 삭제 대상 건수 미리보기
  const handleDeletePreview = async (type: TxType, start: string, end: string) => {
    const cjWh = await findCjWarehouse();
    if (!cjWh) return;
    const typesToDelete = type === '출고' ? ['출고', '판매'] as TxType[] : [type];
    let total = 0;
    for (const t of typesToDelete) {
      total += await countCjTransactions({
        warehouseId: cjWh.id,
        txType: t,
        startDate: start,
        endDate: end,
      });
    }
    setDeletePreviewCount(total);
    setDeleteConfirm(false);
  };

  // 삭제 실행
  const handleDelete = async () => {
    if (!deleteModal) return;
    setDeleting(true);
    const cjWh = await findCjWarehouse();
    if (!cjWh) {
      setDeleting(false);
      return;
    }
    const typesToDelete = deleteModal.type === '출고' ? ['출고', '판매'] as TxType[] : [deleteModal.type];
    let totalDeleted = 0;
    let lastError: string | null = null;
    for (const t of typesToDelete) {
      const result = await deleteCjTransactions({
        warehouseId: cjWh.id,
        txType: t,
        startDate: deleteStartDate,
        endDate: deleteEndDate,
      });
      if (result.error) lastError = result.error;
      totalDeleted += result.deleted;
    }
    setDeleting(false);
    setDeleteModal(null);
    if (lastError) {
      setUploadResult(`삭제 실패: ${lastError}`);
    } else {
      setUploadResult(`${deleteModal.type} 데이터 ${totalDeleted}건 삭제 완료`);
    }
    fetchCjStatus();
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">CJ 입출고 관리</h1>

      {/* CJ 물류센터 데이터 관리 카드 */}
      {(() => {
        const cjTypes: { type: TxType; label: string }[] = [
          { type: '입고', label: '입고' },
          { type: '출고', label: '출고 (판매+이동출고)' },
          { type: '반품', label: '반품' },
        ];
        const getDaysAgo = (dateStr: string) => {
          return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
        };
        const getColor = (days: number) => {
          if (days <= 3) return { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', dot: 'bg-green-500' };
          if (days <= 7) return { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', dot: 'bg-yellow-500' };
          return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-500' };
        };
        return (
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">업로드 현황</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {cjTypes.map(({ type, label }) => {
                const s = type === '출고' && (cjStatus['출고'] || cjStatus['판매'])
                  ? (() => {
                      const out = cjStatus['출고'];
                      const sales = cjStatus['판매'];
                      if (out && sales) {
                        return {
                          count: out.count + sales.count,
                          minDate: out.minDate < sales.minDate ? out.minDate : sales.minDate,
                          maxDate: out.maxDate > sales.maxDate ? out.maxDate : sales.maxDate,
                        };
                      }
                      return out || sales!;
                    })()
                  : cjStatus[type];
                if (!s) {
                  return (
                    <div key={type} className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex flex-col">
                      <div className="text-xs font-semibold text-gray-500 mb-2">{label}</div>
                      <div className="text-xs text-gray-400 mb-3">업로드 없음</div>
                      <label className="mt-auto cursor-pointer bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 inline-flex items-center justify-center gap-1.5">
                        <Upload className="w-3.5 h-3.5" /> 엑셀 업로드
                        <input type="file" accept=".xls,.xlsx" onChange={(e) => handleSingleUpload(e, type)} className="hidden" />
                      </label>
                    </div>
                  );
                }
                const days = getDaysAgo(s.maxDate);
                const c = getColor(days);
                return (
                  <div key={type} className={`${c.bg} border ${c.border} rounded-lg p-3 flex flex-col`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                      <span className="text-xs font-semibold text-gray-700">{label}</span>
                    </div>
                    <div className="text-sm font-bold text-gray-900">최종: {s.maxDate}</div>
                    <div className="flex items-center justify-between mt-1 mb-3">
                      <span className="text-xs text-gray-500">{s.count.toLocaleString()}건</span>
                      <span className={`text-xs font-medium ${c.text}`}>{days === 0 ? '오늘' : `${days}일 전`}</span>
                    </div>
                    <div className="mt-auto flex items-center gap-2">
                      <label className="flex-1 cursor-pointer bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-green-700 inline-flex items-center justify-center gap-1.5">
                        <Upload className="w-3.5 h-3.5" /> 엑셀 업로드
                        <input type="file" accept=".xls,.xlsx" onChange={(e) => handleSingleUpload(e, type)} className="hidden" />
                      </label>
                      <button
                        onClick={() => openDeleteModal(type, s.minDate, s.maxDate)}
                        className="p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="업로드 이력 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 일괄 업로드 */}
            <div className="border-t border-gray-100 pt-3">
              <label className="cursor-pointer bg-gray-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-800 inline-flex items-center gap-2">
                <FileUp className="w-4 h-4" /> 일괄 업로드 (여러 파일)
                <input type="file" accept=".xls,.xlsx" multiple onChange={handleBatchUpload} className="hidden" />
              </label>
              <span className="ml-3 text-xs text-gray-400">파일명으로 입고/출고/반품 자동 감지</span>
            </div>
          </div>
        );
      })()}

      {/* CJ 엑셀 파싱 결과 미리보기 */}
      {(parsedItems.length > 0 || skippedCount > 0) && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-yellow-800">
              CJ {uploadType ? `${uploadType} ` : ''}파싱 결과: {parsedItems.length}건
              {parsedItems.length > 0 && (() => {
                const sorted = [...parsedItems].map(i => i.date).filter(Boolean).sort();
                return sorted.length > 0 ? ` (${sorted[0]} ~ ${sorted[sorted.length - 1]})` : '';
              })()}
            </h3>
            <button onClick={() => { setParsedItems([]); setUploadType(null); setSkippedCount(0); setOverlapWarning(null); }}
              className="text-yellow-600 hover:text-yellow-800"><X className="w-5 h-5" /></button>
          </div>
          {skippedCount > 0 && (
            <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <SkipForward className="w-4 h-4 text-green-600 shrink-0" />
              <span className="text-green-800">전표번호 기준 <strong>{skippedCount}건</strong> 중복 자동 제외 (이미 업로드됨)</span>
            </div>
          )}
          {parsedItems.length === 0 && skippedCount > 0 && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <CheckCircle className="w-4 h-4 text-blue-600 shrink-0" />
              <span className="text-blue-800">모든 데이터({skippedCount}건)가 이미 업로드되어 있습니다. 신규 저장할 항목이 없습니다.</span>
            </div>
          )}
          {overlapWarning && (
            <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mb-3 text-sm">
              <AlertTriangle className="w-4 h-4 text-orange-600 shrink-0" />
              <span className="text-orange-800">{overlapWarning}</span>
            </div>
          )}
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            {(() => {
              const isMixed = !uploadType;
              const colCount = isMixed ? 5 : 4;
              const typeSummary = isMixed ? (() => {
                const m: Record<string, number> = {};
                for (const item of parsedItems) { m[item.type] = (m[item.type] || 0) + 1; }
                return Object.entries(m).map(([t, c]) => `${t} ${c}건`).join(' / ');
              })() : null;
              return (
                <>
                  {typeSummary && (
                    <div className="text-xs text-yellow-700 mb-2 font-medium">{typeSummary}</div>
                  )}
                  <table className="w-full text-xs">
                    <thead className="bg-yellow-100">
                      <tr>
                        {isMixed && <th className="px-2 py-1 text-left">유형</th>}
                        <th className="px-2 py-1 text-left">날짜</th>
                        <th className="px-2 py-1 text-left">SKU코드</th>
                        <th className="px-2 py-1 text-left">상품명</th>
                        <th className="px-2 py-1 text-right">수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsedItems.slice(0, 20).map((item, i) => (
                        <tr key={i} className="border-t border-yellow-100">
                          {isMixed && <td className="px-2 py-1 font-medium">{item.type}</td>}
                          <td className="px-2 py-1">{item.date}</td>
                          <td className="px-2 py-1 font-mono">{item.skuId}</td>
                          <td className="px-2 py-1 max-w-[400px]">{item.skuName}</td>
                          <td className="px-2 py-1 text-right font-semibold">{item.quantity.toLocaleString()}</td>
                        </tr>
                      ))}
                      {parsedItems.length > 20 && (
                        <tr className="border-t border-yellow-100">
                          <td colSpan={colCount} className="px-2 py-1 text-center text-yellow-600">... 외 {parsedItems.length - 20}건</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </>
              );
            })()}
          </div>
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm font-semibold text-red-800">
                  {validationErrors.length}건 검증 실패 — 전체 저장이 차단되었습니다
                </span>
              </div>
              <p className="text-xs text-red-600 mb-2">아래 SKU가 DB에 등록되지 않아 저장할 수 없습니다. 관리자에게 문의하세요.</p>
              <div className="overflow-x-auto max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-red-100">
                    <tr>
                      <th className="px-2 py-1 text-left">SKU코드</th>
                      <th className="px-2 py-1 text-left">상품명</th>
                      <th className="px-2 py-1 text-left">사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationErrors.map((err, i) => (
                      <tr key={i} className="border-t border-red-100">
                        <td className="px-2 py-1 font-mono">{err.skuId}</td>
                        <td className="px-2 py-1">{err.skuName}</td>
                        <td className="px-2 py-1 text-red-600">{err.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {uploading && uploadProgress ? (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-600 font-medium">
                  저장 중... {uploadProgress.current.toLocaleString()} / {uploadProgress.total.toLocaleString()}건
                  ({uploadProgress.total > 0 ? Math.round((uploadProgress.current / uploadProgress.total) * 100) : 0}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-green-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress.total > 0 ? (uploadProgress.current / uploadProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setParsedItems([]); setUploadType(null); setSkippedCount(0); setOverlapWarning(null); setValidationErrors([]); }}
                className="px-4 py-1.5 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">취소</button>
              <button onClick={handleSaveTx} disabled={uploading || parsedItems.length === 0}
                className="bg-green-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                {uploading ? '검증 중...' : `${parsedItems.length}건 저장`}
              </button>
            </div>
          )}
        </div>
      )}

      {uploadResult && !uploading && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-800">
          {uploadResult}
        </div>
      )}

      {/* 삭제 확인 모달 */}
      {deleteModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setDeleteModal(null)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-1">CJ {deleteModal.type} 데이터 삭제</h3>
            <p className="text-sm text-gray-500 mb-4">삭제할 기간을 선택하세요 (CJ 엑셀 업로드 데이터만 삭제됩니다)</p>

            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-1 block">시작일</label>
                <input type="date" value={deleteStartDate}
                  onChange={(e) => {
                    setDeleteStartDate(e.target.value);
                    setDeletePreviewCount(null);
                    setDeleteConfirm(false);
                    if (e.target.value && deleteEndDate) handleDeletePreview(deleteModal.type, e.target.value, deleteEndDate);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
              <span className="text-gray-400 mt-5">~</span>
              <div className="flex-1">
                <label className="text-xs text-gray-500 mb-1 block">종료일</label>
                <input type="date" value={deleteEndDate}
                  onChange={(e) => {
                    setDeleteEndDate(e.target.value);
                    setDeletePreviewCount(null);
                    setDeleteConfirm(false);
                    if (deleteStartDate && e.target.value) handleDeletePreview(deleteModal.type, deleteStartDate, e.target.value);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>

            {deletePreviewCount !== null && (
              <div className={`rounded-lg px-4 py-3 mb-4 text-sm font-medium ${
                deletePreviewCount > 0 ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-gray-50 text-gray-500 border border-gray-200'
              }`}>
                {deletePreviewCount > 0
                  ? `삭제 대상: ${deletePreviewCount.toLocaleString()}건`
                  : '해당 기간에 삭제할 데이터가 없습니다'}
              </div>
            )}

            {deletePreviewCount !== null && deletePreviewCount > 0 && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input type="checkbox" checked={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500" />
                <span className="text-sm text-red-600 font-medium">
                  {deletePreviewCount.toLocaleString()}건을 삭제합니다 (복구 불가)
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteModal(null)}
                className="px-4 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50">
                취소
              </button>
              <button
                onClick={handleDelete}
                disabled={!deleteConfirm || deleting || !deletePreviewCount}
                className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? '삭제 중...' : '삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
