import { useState, useRef, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { getWarehouseId } from '../../lib/warehouseStore';
import { recordTransactionBatch } from '../../lib/inventoryTransaction';
import type { RecordTxParams } from '../../lib/inventoryTransaction';
import { checkNegativeStock, type StockDeduction } from '../../lib/negativeStockCheck';
import NegativeStockWarningModal from '../../components/NegativeStockWarningModal';
import { useStaleGuard } from '../../hooks/useStaleGuard';
import { useLoadingTimeout } from '../../hooks/useLoadingTimeout';
import type { AppUser, NegativeStockItem } from '../../types';
import { AlertTriangle, CheckCircle, FileUp, Search, ArrowRight, Package } from 'lucide-react';

interface TransferItem {
  skuId: string;
  skuName: string;
  barcode: string | null;
  currentQty: number; // 플레이위즈 현재 재고
  transferQty: number; // 이관할 수량
  needsMarking: boolean;
}

export default function TransferToShop({ currentUser }: { currentUser: AppUser }) {
  const [items, setItems] = useState<TransferItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const isStale = useStaleGuard();
  useLoadingTimeout(loading, setLoading, setError);

  // 음수 재고 경고
  const [negativeItems, setNegativeItems] = useState<NegativeStockItem[]>([]);
  const [showNegativeWarning, setShowNegativeWarning] = useState(false);

  const today = new Date().toISOString().split('T')[0];

  // 플레이위즈 재고 로드 (전체)
  const loadInventory = async () => {
    setLoading(true);
    setError(null);
    try {
      const whId = await getWarehouseId('플레이위즈');
      if (!whId) throw new Error('플레이위즈 창고를 찾을 수 없습니다.');

      const { data: inv } = await supabase
        .from('inventory')
        .select('sku_id, quantity, needs_marking, sku(sku_name, barcode)')
        .eq('warehouse_id', whId)
        .eq('needs_marking', false)
        .gt('quantity', 0)
        .order('sku_id');

      if (isStale()) return;
      setItems(
        ((inv || []) as any[]).map((r) => ({
          skuId: r.sku_id,
          skuName: (Array.isArray(r.sku) ? r.sku[0]?.sku_name : r.sku?.sku_name) || r.sku_id,
          barcode: (Array.isArray(r.sku) ? r.sku[0]?.barcode : r.sku?.barcode) || null,
          currentQty: r.quantity,
          transferQty: 0,
          needsMarking: r.needs_marking ?? false,
        }))
      );
    } catch (err: any) {
      setError(err.message || '재고 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadInventory(); }, []);

  // 엑셀 업로드 (SKU + 수량)
  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

      if (rows.length < 2) { setError('데이터가 없습니다.'); return; }
      const headers = rows[0] as string[];
      const skuCol = headers.findIndex((h) => String(h || '').toLowerCase().includes('sku'));
      const barcodeCol = headers.findIndex((h) => String(h || '').toLowerCase().includes('바코드') || String(h || '').toLowerCase().includes('barcode'));
      const qtyCol = headers.findIndex((h) => ['수량', 'qty', 'quantity'].includes(String(h || '').toLowerCase().trim()));

      if (qtyCol === -1) { setError('수량 컬럼을 찾을 수 없습니다.'); return; }

      const uploadMap: Record<string, number> = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        if (!row) continue;
        let key = '';
        if (skuCol !== -1 && row[skuCol]) key = String(row[skuCol]).trim();
        else if (barcodeCol !== -1 && row[barcodeCol]) key = String(row[barcodeCol]).trim();
        const qty = Number(row[qtyCol]) || 0;
        if (key && qty > 0) uploadMap[key] = (uploadMap[key] || 0) + qty;
      }

      // items에 매칭
      setItems((prev) =>
        prev.map((item) => {
          const bySkuId = uploadMap[item.skuId] || 0;
          const byBarcode = (item.barcode && uploadMap[item.barcode]) || 0;
          const qty = bySkuId || byBarcode;
          return { ...item, transferQty: Math.min(qty, item.currentQty) };
        })
      );

      const matched = Object.keys(uploadMap).length;
      const applied = items.filter((i) => uploadMap[i.skuId] || (i.barcode && uploadMap[i.barcode])).length;
      if (matched > applied) {
        setError(`${matched - applied}종이 재고에 없어서 매칭 안 됨`);
      }
    } catch (err: any) {
      setError(err.message || '엑셀 파싱 실패');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 수량 변경
  const handleQtyChange = (skuId: string, nm: boolean, value: number) => {
    setItems((prev) =>
      prev.map((item) =>
        item.skuId === skuId && item.needsMarking === nm
          ? { ...item, transferQty: Math.max(0, Math.min(value, item.currentQty)) }
          : item
      )
    );
  };

  // 이관 실행 (Step 1: 사전 검사 → 음수 있으면 모달, 없으면 즉시 저장)
  const handleTransfer = async () => {
    if (savingRef.current) return;
    const activeItems = items.filter((i) => i.transferQty > 0);
    if (activeItems.length === 0) return;

    setError(null);
    try {
      const pwId = await getWarehouseId('플레이위즈');
      if (!pwId) throw new Error('플레이위즈 창고를 찾을 수 없습니다.');

      // 플레이위즈 출고분만 음수 체크 (오프라인은 입고만 발생)
      const deductions: StockDeduction[] = activeItems.map((i) => ({
        warehouseId: pwId,
        warehouseName: '플레이위즈',
        skuId: i.skuId,
        skuName: i.skuName,
        needsMarking: i.needsMarking,
        deductQty: i.transferQty,
      }));

      const negatives = await checkNegativeStock(deductions);
      if (isStale()) return;

      if (negatives.length > 0) {
        setNegativeItems(negatives);
        setShowNegativeWarning(true);
        return; // 모달에서 사용자 확인 기다림
      }

      // 음수 없음 → 즉시 저장
      await executeTransfer(activeItems, []);
    } catch (err: any) {
      setError(err.message || '이관 실패');
    }
  };

  // 실제 저장 로직 (Step 2: 음수 여부와 관계없이 저장)
  const executeTransfer = async (
    activeItems: TransferItem[],
    negatives: NegativeStockItem[]
  ) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const [pwId, offId] = await Promise.all([
        getWarehouseId('플레이위즈'),
        getWarehouseId('오프라인샵'),
      ]);
      if (!pwId || !offId) throw new Error('창고 정보를 찾을 수 없습니다.');
      const txRows: RecordTxParams[] = [];

      for (const item of activeItems) {
        // 플레이위즈 출고
        txRows.push({
          warehouseId: pwId,
          skuId: item.skuId,
          txType: '출고',
          quantity: item.transferQty,
          source: 'system',
          needsMarking: item.needsMarking,
          memo: `매장이관 출고 ${today}`,
        });
        // 오프라인 매장 입고
        txRows.push({
          warehouseId: offId,
          skuId: item.skuId,
          txType: '이동입고',
          quantity: item.transferQty,
          source: 'system',
          needsMarking: false, // 오프라인은 항상 false
          memo: `매장이관 입고 ${today}`,
        });
      }

      // 음수 허용 여부: 경고 모달에서 사용자가 승인한 경우만 true
      await recordTransactionBatch(txRows, undefined, undefined, {
        allowNegative: negatives.length > 0,
      });

      // Activity log
      await supabase.from('activity_log').insert({
        user_id: currentUser.id,
        action_type: 'shipment_confirm' as any,
        work_order_id: null,
        action_date: today,
        summary: {
          transferToShop: true,
          items: activeItems.map((i) => ({ skuId: i.skuId, skuName: i.skuName, qty: i.transferQty })),
          totalQty: activeItems.reduce((s, i) => s + i.transferQty, 0),
          hasNegativeStock: negatives.length > 0,
          negativeStockItems: negatives.length > 0 ? negatives : undefined,
        },
      });

      if (isStale()) return;
      setShowNegativeWarning(false);
      setNegativeItems([]);
      setSaved(true);
    } catch (err: any) {
      setError(err.message || '이관 실패');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // 음수 재고 경고 모달에서 "계속 진행" 선택
  const handleConfirmNegative = async () => {
    const activeItems = items.filter((i) => i.transferQty > 0);
    await executeTransfer(activeItems, negativeItems);
  };

  const activeItems = items.filter((i) => i.transferQty > 0);
  const totalTransfer = activeItems.reduce((s, i) => s + i.transferQty, 0);

  const filtered = items.filter((i) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return i.skuId.toLowerCase().includes(q) || i.skuName.toLowerCase().includes(q) || (i.barcode || '').toLowerCase().includes(q);
  });

  // needs_marking=false만 조회하므로 별도 그룹 분리 불필요
  const directItems = filtered;

  return (
    <div className="space-y-5 max-w-3xl">
      <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
        <ArrowRight size={22} />
        매장 재고 이관
      </h2>
      <p className="text-sm text-gray-500 -mt-3">플레이위즈 → 오프라인 매장으로 재고를 이관합니다</p>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {saved ? (
        <div className="bg-green-50 border border-green-200 rounded-xl p-6 text-center">
          <CheckCircle size={32} className="mx-auto text-green-500 mb-3" />
          <p className="text-lg font-semibold text-green-800">이관 완료!</p>
          <p className="text-sm text-green-600 mt-1">{activeItems.length}종 {totalTransfer}개 → 오프라인 매장</p>
          <button onClick={() => { setSaved(false); loadInventory(); }} className="mt-4 text-sm text-green-700 underline">새 이관 등록</button>
        </div>
      ) : (
        <>
          {/* 엑셀 업로드 + 검색 */}
          <div className="flex gap-2">
            <button onClick={() => fileInputRef.current?.click()} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 text-sm border border-teal-300 rounded-lg text-teal-600 hover:bg-teal-50 disabled:opacity-50">
              <FileUp size={15} />{loading ? '로딩 중...' : '엑셀 업로드'}
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelUpload} />
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU / 상품명 / 바코드 검색..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>
          </div>

          {/* 소계 */}
          {totalTransfer > 0 && (
            <div className="bg-teal-50 rounded-xl p-3 flex justify-between items-center">
              <span className="text-sm text-teal-700">이관 수량</span>
              <span className="text-sm font-bold text-teal-900">{activeItems.length}종 / {totalTransfer}개</span>
            </div>
          )}

          {/* 재고 목록 */}
          {loading ? (
            <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-400 text-sm">불러오는 중...</div>
          ) : items.length === 0 ? (
            <div className="bg-gray-50 rounded-xl p-8 text-center text-gray-400 text-sm">플레이위즈 재고가 없습니다</div>
          ) : (
            <div className="space-y-4">
              {/* 단품 */}
              {directItems.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm border border-emerald-200 overflow-hidden">
                  <div className="px-4 py-2.5 bg-emerald-50 border-b border-emerald-200">
                    <p className="text-xs font-semibold text-emerald-700">단품 / 일반 재고 ({directItems.length}종)</p>
                  </div>
                  <div className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
                    {directItems.map((item) => (
                      <div key={`${item.skuId}_${item.needsMarking}`} className="px-4 py-2.5 flex items-center justify-between">
                        <div className="flex-1 min-w-0 mr-3">
                          <p className="text-sm font-medium text-gray-800 truncate">{item.skuName}</p>
                          <p className="text-xs text-gray-400 font-mono">{item.skuId}{item.barcode ? ` · ${item.barcode}` : ''}</p>
                          <p className="text-xs text-emerald-600">재고: {item.currentQty}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          <input type="number" min="0" max={item.currentQty} value={item.transferQty}
                            onChange={(e) => handleQtyChange(item.skuId, item.needsMarking, Number(e.target.value))}
                            className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-teal-500" />
                          <span className="text-xs text-gray-400">개</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* 이관 버튼 */}
          <button onClick={handleTransfer} disabled={saving || totalTransfer === 0}
            className="w-full bg-teal-600 text-white py-3.5 rounded-xl font-semibold hover:bg-teal-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base">
            <Package size={20} />
            {saving ? '처리 중...' : `매장으로 이관 (${activeItems.length}종 ${totalTransfer}개)`}
          </button>
        </>
      )}

      {/* 음수 재고 경고 모달 */}
      <NegativeStockWarningModal
        open={showNegativeWarning}
        items={negativeItems}
        confirming={saving}
        onCancel={() => {
          if (saving) return;
          setShowNegativeWarning(false);
          setNegativeItems([]);
        }}
        onConfirm={handleConfirmNegative}
      />
    </div>
  );
}
