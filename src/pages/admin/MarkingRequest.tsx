import { useState, useRef, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import type { AppUser } from '../../types';
import { AlertTriangle, CheckCircle, FileUp, Search, ClipboardList, Clock, Trash2 } from 'lucide-react';

interface RequestItem {
  finishedSkuId: string;
  skuName: string;
  barcode: string | null;
  qty: number;
  components: { skuId: string; skuName: string; needed: number; available: number }[];
  canMark: boolean;
}

interface MarkingRequestRow {
  id: string;
  request_date: string;
  status: string;
  items: RequestItem[];
  requested_at: string;
  notes: string | null;
}

export default function MarkingRequest({ currentUser }: { currentUser: AppUser }) {
  const [items, setItems] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 최근 요청 이력
  const [requests, setRequests] = useState<MarkingRequestRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => { loadRequests(); }, []);

  const loadRequests = async () => {
    setHistoryLoading(true);
    try {
      const { data } = await supabase
        .from('marking_request')
        .select('id, request_date, status, items, requested_at, notes')
        .order('requested_at', { ascending: false })
        .limit(20);
      setRequests((data || []) as MarkingRequestRow[]);
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
  };

  // 엑셀 업로드 (기존 ManualMarking 로직)
  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setLoading(true);
    setSaved(false);

    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });

      if (rows.length < 2) { setError('데이터가 없습니다.'); setLoading(false); return; }

      const headers = rows[0] as string[];
      const skuCol = headers.findIndex((h) => String(h || '').toLowerCase().includes('sku'));
      const qtyCol = headers.findIndex((h) => ['수량', 'qty', 'quantity'].includes(String(h || '').toLowerCase().trim()));

      if (skuCol === -1 || qtyCol === -1) {
        setError('SKU ID와 수량 컬럼을 찾을 수 없습니다.');
        setLoading(false);
        return;
      }

      const skuQtyMap: Record<string, number> = {};
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i] as unknown[];
        if (!row || !row[skuCol]) continue;
        const sku = String(row[skuCol]).trim();
        const qty = Number(row[qtyCol]) || 0;
        if (qty > 0) skuQtyMap[sku] = (skuQtyMap[sku] || 0) + qty;
      }

      const skuIds = Object.keys(skuQtyMap);
      if (skuIds.length === 0) { setError('유효한 SKU가 없습니다.'); setLoading(false); return; }

      const { data: boms } = await supabase
        .from('bom')
        .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_name)')
        .in('finished_sku_id', skuIds);

      const { data: skuInfos } = await supabase.from('sku').select('sku_id, sku_name, barcode').in('sku_id', skuIds);
      const skuMap = new Map((skuInfos || []).map((s: any) => [s.sku_id, s]));

      const { data: wh } = await supabase.from('warehouse').select('id').eq('name', '플레이위즈').maybeSingle();
      const allCompSkus = new Set<string>();
      for (const b of (boms || []) as any[]) allCompSkus.add(b.component_sku_id);

      let invMap: Record<string, number> = {};
      if (wh && allCompSkus.size > 0) {
        const { data: inv } = await supabase
          .from('inventory')
          .select('sku_id, quantity')
          .eq('warehouse_id', (wh as any).id)
          .in('sku_id', [...allCompSkus]);
        for (const i of (inv || []) as any[]) invMap[i.sku_id] = (invMap[i.sku_id] || 0) + i.quantity;
      }

      const bomMap: Record<string, { skuId: string; skuName: string; qty: number }[]> = {};
      for (const b of (boms || []) as any[]) {
        if (!bomMap[b.finished_sku_id]) bomMap[b.finished_sku_id] = [];
        bomMap[b.finished_sku_id].push({ skuId: b.component_sku_id, skuName: b.component?.sku_name || b.component_sku_id, qty: b.quantity || 1 });
      }

      const markingItems: RequestItem[] = [];
      for (const [skuId, qty] of Object.entries(skuQtyMap)) {
        const info = skuMap.get(skuId);
        const comps = bomMap[skuId] || [];
        const components = comps.map((c) => ({ skuId: c.skuId, skuName: c.skuName, needed: c.qty * qty, available: invMap[c.skuId] || 0 }));
        const canMark = comps.length > 0 && components.every((c) => c.available >= c.needed);
        markingItems.push({ finishedSkuId: skuId, skuName: info?.sku_name || skuId, barcode: info?.barcode || null, qty, components, canMark });
      }

      markingItems.sort((a, b) => (a.canMark === b.canMark ? 0 : a.canMark ? -1 : 1));
      setItems(markingItems);
    } catch (err: any) {
      setError(err.message || '엑셀 파싱 실패');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleQtyChange = (skuId: string, value: number) => {
    setItems((prev) => prev.map((item) => (item.finishedSkuId === skuId ? { ...item, qty: Math.max(0, value) } : item)));
  };

  // 요청 등록 (marking_request에 pending 저장 — 트랜잭션 생성 안 함)
  const handleSubmitRequest = async () => {
    const activeItems = items.filter((i) => i.qty > 0);
    if (activeItems.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const { error: insertErr } = await supabase.from('marking_request').insert({
        requested_by: currentUser.id,
        request_date: new Date().toISOString().split('T')[0],
        status: 'pending',
        items: activeItems.map((i) => ({
          finishedSkuId: i.finishedSkuId,
          skuName: i.skuName,
          barcode: i.barcode,
          qty: i.qty,
          components: i.components,
          canMark: i.canMark,
        })),
        notes: notes.trim() || null,
      });
      if (insertErr) throw insertErr;

      setSaved(true);
      setItems([]);
      setNotes('');
      loadRequests();
    } catch (err: any) {
      setError(err.message || '요청 등록 실패');
    } finally {
      setSaving(false);
    }
  };

  // 요청 취소
  const handleCancel = async (id: string) => {
    await supabase.from('marking_request').update({ status: 'cancelled' }).eq('id', id);
    loadRequests();
  };

  const canMarkItems = items.filter((i) => i.qty > 0 && i.canMark);
  const totalQty = items.filter((i) => i.qty > 0).reduce((s, i) => s + i.qty, 0);

  const filtered = items.filter((i) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return i.finishedSkuId.toLowerCase().includes(q) || i.skuName.toLowerCase().includes(q);
  });

  const statusLabel: Record<string, { text: string; color: string }> = {
    pending: { text: '대기중', color: 'bg-yellow-100 text-yellow-800' },
    in_progress: { text: '작업중', color: 'bg-blue-100 text-blue-800' },
    completed: { text: '완료', color: 'bg-green-100 text-green-800' },
    cancelled: { text: '취소', color: 'bg-gray-100 text-gray-500' },
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h2 className="text-xl font-bold text-gray-900">수기 마킹 요청</h2>

      {/* 요청 등록 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
        <div>
          <h3 className="font-medium text-gray-900">마킹 요청 등록</h3>
          <p className="text-xs text-gray-500 mt-0.5">완제품 SKU + 수량 엑셀을 업로드하면 BOM/재고를 확인합니다</p>
        </div>

        <div className="flex gap-2">
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-indigo-300 rounded-lg text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">
            <FileUp size={15} />{loading ? '분석 중...' : '엑셀 업로드'}
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleExcelUpload} />
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
            <AlertTriangle size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {saved && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
            <CheckCircle size={24} className="mx-auto text-green-500 mb-2" />
            <p className="text-sm text-green-800 font-medium">마킹 요청이 등록되었습니다. 플레이위즈에서 확인 후 작업합니다.</p>
            <button onClick={() => setSaved(false)} className="mt-2 text-xs text-green-600 underline">새 요청 등록</button>
          </div>
        )}

        {items.length > 0 && !saved && (
          <>
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="SKU / 상품명 검색..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm" />
            </div>

            <div className="bg-indigo-50 rounded-xl p-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-indigo-700">마킹 가능</span>
                <span className="font-semibold text-indigo-800">{canMarkItems.length}종 / {canMarkItems.reduce((s, i) => s + i.qty, 0)}개</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">전체 요청</span>
                <span className="font-semibold text-gray-800">{items.filter((i) => i.qty > 0).length}종 / {totalQty}개</span>
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-50 max-h-80 overflow-y-auto">
              {filtered.map((item) => (
                <div key={item.finishedSkuId} className={`px-4 py-3 ${!item.canMark ? 'bg-red-50/50' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="text-sm font-medium text-gray-800 truncate">{item.skuName}</p>
                      <p className="text-xs text-gray-400 font-mono">{item.finishedSkuId}</p>
                      <div className="mt-1 space-y-0.5">
                        {item.components.map((c) => (
                          <p key={c.skuId} className={`text-xs ${c.available < c.needed ? 'text-red-500' : 'text-gray-500'}`}>
                            {c.skuName}: 필요 {c.needed} / 재고 {c.available}
                          </p>
                        ))}
                        {item.components.length === 0 && <p className="text-xs text-orange-500">BOM 미등록</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <input type="number" min="0" value={item.qty}
                        onChange={(e) => handleQtyChange(item.finishedSkuId, Number(e.target.value))}
                        className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                      <span className="text-xs text-gray-400">개</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="메모 (선택)"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" rows={2} />

            <button onClick={handleSubmitRequest} disabled={saving || totalQty === 0}
              className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2 text-base">
              <ClipboardList size={20} />
              {saving ? '등록 중...' : `마킹 요청 등록 (${items.filter((i) => i.qty > 0).length}종 ${totalQty}개)`}
            </button>
          </>
        )}
      </div>

      {/* 최근 요청 이력 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-medium text-gray-900 flex items-center gap-2"><Clock size={16} />요청 이력</h3>
        </div>
        {historyLoading ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">불러오는 중...</div>
        ) : requests.length === 0 ? (
          <div className="px-5 py-8 text-center text-gray-400 text-sm">요청 이력이 없습니다</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {requests.map((req) => {
              const reqItems = (req.items || []) as RequestItem[];
              const total = reqItems.reduce((s, i) => s + (i.qty || 0), 0);
              const st = statusLabel[req.status] || statusLabel.pending;
              return (
                <div key={req.id} className="px-5 py-3 flex items-center gap-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${st.color}`}>{st.text}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-800">{req.request_date} — {reqItems.length}종 {total}개</p>
                    {req.notes && <p className="text-xs text-gray-400 truncate">{req.notes}</p>}
                  </div>
                  {req.status === 'pending' && (
                    <button onClick={() => handleCancel(req.id)} className="text-red-400 hover:text-red-600" title="취소">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
