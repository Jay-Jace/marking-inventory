import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { parseBomExcel } from '../../lib/excelParser';
import { Upload, Database, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';

interface BomEntry {
  id: string;
  finished_sku_id: string;
  finished_sku: { sku_name: string } | null;
  component_sku_id: string;
  component: { sku_name: string } | null;
  quantity: number;
}

export default function BOMManage() {
  const [boms, setBoms] = useState<BomEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadBoms();
  }, []);

  const loadBoms = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('bom')
      .select(
        'id, finished_sku_id, finished_sku:sku!bom_finished_sku_id_fkey(sku_name), component_sku_id, component:sku!bom_component_sku_id_fkey(sku_name), quantity'
      )
      .order('finished_sku_id');
    setBoms((data || []) as any[]);
    setLoading(false);
  };

  const handleBomUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);

    try {
      const rows = await parseBomExcel(file);

      // SKU 등록 (완제품 + 단품)
      const allSkus = [
        ...rows.map((r) => ({ sku_id: r.finishedSkuId, sku_name: r.finishedSkuName, barcode: null, type: '완제품' })),
        ...rows.map((r) => ({
          sku_id: r.componentSkuId,
          sku_name: r.componentSkuName,
          barcode: null,
          type: r.componentSkuName.includes('마킹') ? '마킹단품' : '유니폼단품',
        })),
      ];

      await supabase.from('sku').upsert(allSkus, { onConflict: 'sku_id', ignoreDuplicates: true });

      // BOM 등록
      const bomRows = rows.map((r) => ({
        finished_sku_id: r.finishedSkuId,
        component_sku_id: r.componentSkuId,
        quantity: r.quantity,
      }));

      const { error } = await supabase
        .from('bom')
        .upsert(bomRows, { onConflict: 'finished_sku_id,component_sku_id' });

      if (error) throw error;

      setMessage({ type: 'success', text: `BOM ${rows.length}건이 등록되었습니다.` });
      loadBoms();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'BOM 업로드 중 오류가 발생했습니다.' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('이 BOM 항목을 삭제하시겠습니까?')) return;
    await supabase.from('bom').delete().eq('id', id);
    loadBoms();
  };

  // 완제품별로 그룹화
  const grouped: Record<string, BomEntry[]> = {};
  for (const bom of boms) {
    if (!grouped[bom.finished_sku_id]) grouped[bom.finished_sku_id] = [];
    grouped[bom.finished_sku_id].push(bom);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">BOM 관리</h2>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          <Upload size={16} />
          {uploading ? '업로드 중...' : 'BOM 엑셀 업로드'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleBomUpload}
          className="hidden"
        />
      </div>

      {/* BOM 엑셀 양식 안내 */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">BOM 엑셀 파일 양식</h3>
        <p className="text-xs text-blue-700 mb-1">
          헤더 행 포함, 다음 컬럼 순서로 작성하세요:
        </p>
        <code className="text-xs text-blue-800 bg-blue-100 px-2 py-1 rounded">
          완제품 SKU ID | 완제품 SKU명 | 단품 SKU ID | 단품 SKU명 | 수량
        </code>
        <p className="text-xs text-blue-600 mt-2">
          예: 완제품 1개에 유니폼 1개 + 마킹 1개가 필요하면 2행으로 작성
        </p>
      </div>

      {message && (
        <div
          className={`flex items-center gap-3 p-4 rounded-xl border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-200 text-green-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {message.type === 'success' ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
          <p className="text-sm">{message.text}</p>
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-8">불러오는 중...</div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Database size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500">등록된 BOM이 없습니다.</p>
          <p className="text-sm text-gray-400 mt-1">BOM 엑셀 파일을 업로드하세요.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([finishedSkuId, items]) => (
            <div
              key={finishedSkuId}
              className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden"
            >
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
                <p className="font-medium text-gray-900 text-sm">
                  {items[0].finished_sku?.sku_name || finishedSkuId}
                </p>
                <p className="text-xs text-gray-500 font-mono">{finishedSkuId}</p>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {items.map((bom) => (
                    <tr key={bom.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="px-4 py-2.5 text-gray-700">
                        {bom.component?.sku_name || bom.component_sku_id}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">
                        {bom.component_sku_id}
                      </td>
                      <td className="px-4 py-2.5 text-gray-900 font-medium text-right">
                        ×{bom.quantity}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => handleDelete(bom.id)}
                          className="text-gray-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
