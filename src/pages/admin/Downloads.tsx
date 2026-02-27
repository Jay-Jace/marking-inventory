import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  exportAllForms,
  exportInventoryAdjustment,
  exportCjReceiptRequest,
  exportProductionReceiptRequest,
  type TransferLine,
  type InventoryAdjLine,
  type CjReceiptLine,
} from '../../lib/excelExporter';
import { Download, Lock, CheckCircle, ChevronDown } from 'lucide-react';

interface WorkOrderOption {
  id: string;
  download_date: string;
  status: string;
}

export default function Downloads() {
  const [workOrders, setWorkOrders] = useState<WorkOrderOption[]>([]);
  const [selectedWoId, setSelectedWoId] = useState('');
  const [loading, setLoading] = useState(false);
  const [warehouses, setWarehouses] = useState<Record<string, any>>({});

  useEffect(() => {
    loadWorkOrders();
    loadWarehouses();
  }, []);

  const loadWorkOrders = async () => {
    const { data } = await supabase
      .from('work_order')
      .select('id, download_date, status')
      .order('uploaded_at', { ascending: false });
    setWorkOrders((data || []) as WorkOrderOption[]);
    if (data && data.length > 0) setSelectedWoId(data[0].id);
  };

  const loadWarehouses = async () => {
    const { data } = await supabase.from('warehouse').select('*');
    const map: Record<string, any> = {};
    (data || []).forEach((w: any) => (map[w.name] = w));
    setWarehouses(map);
  };

  const selectedWo = workOrders.find((w) => w.id === selectedWoId);

  // 각 단계 다운로드 가능 여부
  const step1Available = selectedWo
    ? ['이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
    : false;
  const step2Available = selectedWo
    ? ['입고확인완료', '마킹중', '마킹완료', '출고완료'].includes(selectedWo.status)
    : false;
  const step3Available = selectedWo
    ? ['마킹완료', '출고완료'].includes(selectedWo.status)
    : false;

  // STEP 1: 이관지시서 + 재고조정(오프라인 M차감)
  const handleDownloadStep1 = async () => {
    if (!selectedWoId) return;
    setLoading(true);

    const { data: lines } = await supabase
      .from('work_order_line')
      .select('*, finished_sku(sku_id, sku_name)')
      .eq('work_order_id', selectedWoId);

    const { data: bomData } = await supabase
      .from('bom')
      .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)');

    const offlineWarehouse = warehouses['오프라인샵'];
    const playwithWarehouse = warehouses['플레이위즈'];

    // BOM 기반 이관지시서 (단품 단위 집계)
    const componentMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};

    for (const line of (lines || []) as any[]) {
      if (!line.needs_marking) continue;
      const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
      for (const bom of boms as any[]) {
        const key = bom.component_sku_id;
        if (!componentMap[key]) {
          componentMap[key] = {
            skuId: bom.component_sku_id,
            skuName: bom.component?.sku_name || bom.component_sku_id,
            qty: 0,
          };
        }
        componentMap[key].qty += bom.quantity * line.ordered_qty;
      }
    }

    // 단품 주문 항목도 이관 대상에 포함
    for (const line of (lines || []) as any[]) {
      if (line.needs_marking) continue;
      const key = line.finished_sku_id;
      if (!componentMap[key]) {
        componentMap[key] = {
          skuId: line.finished_sku_id,
          skuName: line.finished_sku?.sku_name || line.finished_sku_id,
          qty: 0,
        };
      }
      componentMap[key].qty += line.ordered_qty;
    }

    const transferLines: TransferLine[] = Object.values(componentMap).map((c) => ({
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
    }));

    // 재고조정 (오프라인샵 M차감)
    const adjLines: InventoryAdjLine[] = Object.values(componentMap).map((c) => ({
      warehouseId: offlineWarehouse?.external_id || offlineWarehouse?.id || '오프라인샵',
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
      code: 'M',
      reason: 'ETC',
    }));

    exportAllForms({
      transferLines,
      offlineAdjLines: adjLines,
      date: selectedWo?.download_date || new Date().toISOString().split('T')[0],
      fromWarehouseName: offlineWarehouse?.name || '오프라인샵',
      toWarehouseName: playwithWarehouse?.name || '플레이위즈',
    });

    setLoading(false);
  };

  // STEP 2: 재고조정 (제작창고 P증가)
  const handleDownloadStep2 = async () => {
    if (!selectedWoId) return;
    setLoading(true);

    const { data: lines } = await supabase
      .from('work_order_line')
      .select('*, finished_sku(sku_id, sku_name)')
      .eq('work_order_id', selectedWoId)
      .gt('received_qty', 0);

    const { data: bomData } = await supabase
      .from('bom')
      .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)');

    const playwithWarehouse = warehouses['플레이위즈'];
    const componentMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};

    for (const line of (lines || []) as any[]) {
      if (!line.needs_marking) continue;
      const boms = (bomData || []).filter((b: any) => b.finished_sku_id === line.finished_sku_id);
      for (const bom of boms as any[]) {
        const key = bom.component_sku_id;
        if (!componentMap[key]) {
          componentMap[key] = { skuId: bom.component_sku_id, skuName: bom.component?.sku_name || '', qty: 0 };
        }
        componentMap[key].qty += bom.quantity * line.received_qty;
      }
    }

    const adjLines: InventoryAdjLine[] = Object.values(componentMap).map((c) => ({
      warehouseId: playwithWarehouse?.external_id || playwithWarehouse?.id || '플레이위즈',
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
      code: 'P',
      reason: 'ETC',
    }));

    exportInventoryAdjustment(
      adjLines,
      selectedWo?.download_date || new Date().toISOString().split('T')[0],
      '제작창고P증가'
    );
    setLoading(false);
  };

  // STEP 3: 재고조정(제작창고 M차감) + CJ입고요청 + 생산입고요청
  const handleDownloadStep3 = async () => {
    if (!selectedWoId) return;
    setLoading(true);

    // 당일 완료된 마킹 데이터
    const { data: markings } = await supabase
      .from('daily_marking')
      .select('*, line:work_order_line(finished_sku_id, needs_marking, finished_sku(sku_id, sku_name))')
      .eq('line.work_order_id', selectedWoId);

    const { data: bomData } = await supabase
      .from('bom')
      .select('finished_sku_id, component_sku_id, quantity, component:sku!bom_component_sku_id_fkey(sku_id, sku_name)');

    const playwithWarehouse = warehouses['플레이위즈'];
    const cjWarehouse = warehouses['CJ창고'];
    const today = new Date().toISOString().split('T')[0];

    // 제작창고 M차감 (단품 단위)
    const mAdjMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};
    // 생산입고요청 (완제품 단위)
    const productionMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};
    // CJ입고 (완제품 + 단품 모두)
    const cjMap: Record<string, { skuId: string; skuName: string; qty: number }> = {};

    for (const marking of (markings || []) as any[]) {
      if (marking.completed_qty <= 0) continue;
      const line = marking.line;
      if (!line) continue;

      const finishedSkuId = line.finished_sku_id;
      const finishedSkuName = line.finished_sku?.sku_name || finishedSkuId;
      const qty = marking.completed_qty;

      if (line.needs_marking) {
        // 단품 차감
        const boms = (bomData || []).filter((b: any) => b.finished_sku_id === finishedSkuId);
        for (const bom of boms as any[]) {
          const key = bom.component_sku_id;
          if (!mAdjMap[key]) mAdjMap[key] = { skuId: bom.component_sku_id, skuName: bom.component?.sku_name || '', qty: 0 };
          mAdjMap[key].qty += bom.quantity * qty;
        }
        // 완제품 생산입고
        if (!productionMap[finishedSkuId]) productionMap[finishedSkuId] = { skuId: finishedSkuId, skuName: finishedSkuName, qty: 0 };
        productionMap[finishedSkuId].qty += qty;
        // CJ입고 (완제품)
        if (!cjMap[finishedSkuId]) cjMap[finishedSkuId] = { skuId: finishedSkuId, skuName: finishedSkuName, qty: 0 };
        cjMap[finishedSkuId].qty += qty;
      }
    }

    const mAdjLines: InventoryAdjLine[] = Object.values(mAdjMap).map((c) => ({
      warehouseId: playwithWarehouse?.external_id || playwithWarehouse?.id || '플레이위즈',
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
      code: 'M',
      reason: 'ETC',
    }));

    const cjLines: CjReceiptLine[] = Object.values(cjMap).map((c) => ({
      deliveryWarehouseId: cjWarehouse?.external_id || cjWarehouse?.id || 'CJ창고',
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
      receiptType: 'G',
      requestDate: today,
    }));

    const productionLines: CjReceiptLine[] = Object.values(productionMap).map((c) => ({
      deliveryWarehouseId: cjWarehouse?.external_id || cjWarehouse?.id || 'CJ창고',
      skuId: c.skuId,
      skuName: c.skuName,
      quantity: c.qty,
      receiptType: 'P',
      requestDate: today,
    }));

    if (mAdjLines.length > 0) exportInventoryAdjustment(mAdjLines, today, '제작창고M차감');
    if (cjLines.length > 0) exportCjReceiptRequest(cjLines, today);
    if (productionLines.length > 0) exportProductionReceiptRequest(productionLines, today);

    setLoading(false);
  };

  const steps = [
    {
      label: 'STEP 1',
      title: '작업지시서 등록 직후',
      available: step1Available,
      pendingMsg: '작업지시서 업로드 후 활성화됩니다',
      items: [
        { num: '①', name: '이관지시서' },
        { num: '②', name: '재고조정양식 (오프라인샵 M차감)' },
      ],
      onDownload: handleDownloadStep1,
      combined: true,
    },
    {
      label: 'STEP 2',
      title: '플레이위즈 입고 확인 후',
      available: step2Available,
      pendingMsg: '플레이위즈 입고 확인 후 활성화됩니다',
      items: [{ num: '③', name: '재고조정양식 (제작창고 P증가)' }],
      onDownload: handleDownloadStep2,
      combined: false,
    },
    {
      label: 'STEP 3',
      title: '마킹 작업 완료 후',
      available: step3Available,
      pendingMsg: '마킹 완료 저장 후 활성화됩니다',
      items: [
        { num: '④', name: '재고조정양식 (제작창고 M차감)' },
        { num: '⑤', name: 'CJ창고 입고요청양식 (G타입)' },
        { num: '⑥', name: '생산입고요청양식 (P타입)' },
      ],
      onDownload: handleDownloadStep3,
      combined: false,
    },
  ];

  return (
    <div className="space-y-6 max-w-2xl">
      <h2 className="text-xl font-bold text-gray-900">BERRIZ 업로드용 양식 다운로드</h2>

      {/* 작업지시서 선택 */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">작업지시서 선택</label>
        <div className="relative">
          <select
            value={selectedWoId}
            onChange={(e) => setSelectedWoId(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {workOrders.map((wo) => (
              <option key={wo.id} value={wo.id}>
                {wo.download_date} — {wo.status}
              </option>
            ))}
          </select>
          <ChevronDown size={16} className="absolute right-3 top-3 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* 단계별 다운로드 */}
      {steps.map((step) => (
        <div
          key={step.label}
          className={`bg-white rounded-xl shadow-sm border overflow-hidden ${
            step.available ? 'border-gray-100' : 'border-gray-100 opacity-70'
          }`}
        >
          <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">
                {step.label}
              </span>
              <h3 className="font-medium text-gray-900 mt-0.5">{step.title}</h3>
            </div>
            {step.available ? (
              <CheckCircle size={18} className="text-green-500" />
            ) : (
              <Lock size={18} className="text-gray-300" />
            )}
          </div>

          <div className="px-5 py-4">
            <ul className="space-y-1.5 mb-4">
              {step.items.map((item) => (
                <li key={item.num} className="flex items-center gap-2 text-sm text-gray-700">
                  <span className="text-blue-600 font-medium">{item.num}</span>
                  {item.name}
                </li>
              ))}
            </ul>

            {step.available ? (
              <button
                onClick={step.onDownload}
                disabled={loading}
                className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                <Download size={16} />
                {step.combined ? '묶음 다운로드 (.xlsx)' : '다운로드'}
              </button>
            ) : (
              <p className="text-sm text-gray-400 flex items-center gap-1.5">
                <Lock size={14} />
                {step.pendingMsg}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
