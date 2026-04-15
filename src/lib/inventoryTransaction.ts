import { supabase } from './supabase';
import { supabaseAdmin } from './supabaseAdmin';
import type { TxType, TxSource } from '../types';

/** 음수 수량이 허용되는 트랜잭션 유형 (재고조정/마킹 롤백 등) */
const ALLOW_NEGATIVE_TYPES: TxType[] = ['재고조정', '마킹출고', '마킹입고'];

export interface RecordTxParams {
  warehouseId: string;
  skuId: string;
  txType: TxType;
  quantity: number;
  source: TxSource;
  txDate?: string;
  memo?: string;
  needsMarking?: boolean;
}

/** 재고 변동 1건 기록 */
export async function recordTransaction(params: RecordTxParams): Promise<void> {
  if (params.quantity === 0) return;
  // 마킹 관련 타입은 음수 허용 (롤백/수정 시 역방향 트랜잭션 필요)
  const allowNegative = ALLOW_NEGATIVE_TYPES.includes(params.txType);
  if (params.quantity < 0 && !allowNegative) return;
  const { error } = await supabase.from('inventory_transaction').insert({
    warehouse_id: params.warehouseId,
    sku_id: params.skuId,
    tx_type: params.txType,
    quantity: params.quantity,
    source: params.source,
    tx_date: params.txDate || new Date().toISOString().slice(0, 10),
    memo: params.memo || null,
    needs_marking: params.needsMarking ?? false,
  });
  if (error) console.error('[inventoryTransaction] insert error:', error);
}

/** 없는 SKU를 sku 테이블에 자동 등록 */
async function ensureSkuExists(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>
): Promise<void> {
  const uniqueSkuIds = [...new Set(rows.map((r) => r.skuId))];
  if (uniqueSkuIds.length === 0) return;

  // 500개씩 존재 여부 확인 (admin으로 RLS 우회)
  const existingIds = new Set<string>();
  for (let i = 0; i < uniqueSkuIds.length; i += 500) {
    const batch = uniqueSkuIds.slice(i, i + 500);
    const { data } = await supabaseAdmin.from('sku').select('sku_id').in('sku_id', batch);
    if (data) data.forEach((d) => existingIds.add(d.sku_id));
  }

  const missing = uniqueSkuIds.filter((id) => !existingIds.has(id));
  if (missing.length === 0) return;

  console.log(`[inventoryTransaction] ${missing.length}개 SKU 자동 등록:`, missing);
  const newSkus = missing.map((skuId) => ({
    sku_id: skuId,
    sku_name: skuNameMap?.get(skuId) || skuId,
    type: '완제품',
  }));

  // 500개씩 배치 insert (admin으로 RLS 우회)
  for (let i = 0; i < newSkus.length; i += 500) {
    const batch = newSkus.slice(i, i + 500);
    const { error } = await supabaseAdmin.from('sku').insert(batch);
    if (error) console.error('[inventoryTransaction] sku insert error:', error);
  }
}

export interface ValidationError {
  skuId: string;
  skuName: string;
  reason: string;
}

/** 저장 전 검증: SKU 자동 등록 시도 후 여전히 누락된 SKU 확인 */
export async function validateTransactionBatch(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>
): Promise<{ valid: boolean; errors: ValidationError[] }> {
  // 음수 허용 타입(재고조정/마킹출고/마킹입고)은 음수도 유효, 그 외는 양수만 유효
  const validRows = rows.filter(
    (r) => r.quantity !== 0 && (r.quantity > 0 || ALLOW_NEGATIVE_TYPES.includes(r.txType))
  );
  if (validRows.length === 0) return { valid: true, errors: [] };

  // 1) 없는 SKU 자동 등록 시도
  await ensureSkuExists(validRows, skuNameMap);

  // 2) 등록 후에도 여전히 누락된 SKU 확인
  const uniqueSkuIds = [...new Set(validRows.map((r) => r.skuId))];
  const existingIds = new Set<string>();
  for (let i = 0; i < uniqueSkuIds.length; i += 500) {
    const batch = uniqueSkuIds.slice(i, i + 500);
    const { data } = await supabaseAdmin.from('sku').select('sku_id').in('sku_id', batch);
    if (data) data.forEach((d) => existingIds.add(d.sku_id));
  }

  const missingSkuIds = uniqueSkuIds.filter((id) => !existingIds.has(id));
  if (missingSkuIds.length === 0) return { valid: true, errors: [] };

  const errors: ValidationError[] = missingSkuIds.map((skuId) => ({
    skuId,
    skuName: skuNameMap?.get(skuId) || skuId,
    reason: 'SKU 자동 등록 실패 (DB 제약 조건 위반 가능)',
  }));

  return { valid: false, errors };
}

export interface RecordBatchOptions {
  /** inventory upsert 시 음수 재고 허용 여부 (기본 false: Math.max(0, ...) 클램프 적용) */
  allowNegative?: boolean;
}

/** 재고 변동 여러건 일괄 기록 (CJ 엑셀 업로드용) */
export async function recordTransactionBatch(
  rows: RecordTxParams[],
  skuNameMap?: Map<string, string>,
  onProgress?: (current: number, total: number) => void,
  options?: RecordBatchOptions
): Promise<{ success: number; failed: number }> {
  // 음수 허용 타입(재고조정/마킹출고/마킹입고)은 음수도 유효, 그 외는 양수만 유효
  const valid = rows.filter(
    (r) => r.quantity !== 0 && (r.quantity > 0 || ALLOW_NEGATIVE_TYPES.includes(r.txType))
  );
  if (valid.length === 0) return { success: 0, failed: 0 };

  // 1) 없는 SKU 자동 등록
  await ensureSkuExists(valid, skuNameMap);

  const insertRows = valid.map((r) => ({
    warehouse_id: r.warehouseId,
    sku_id: r.skuId,
    tx_type: r.txType,
    quantity: r.quantity,
    source: r.source,
    tx_date: r.txDate || new Date().toISOString().slice(0, 10),
    memo: r.memo || null,
    needs_marking: r.needsMarking ?? false,
  }));

  // 2) 500건씩 배치 insert
  let success = 0;
  let failed = 0;
  const total = insertRows.length;
  for (let i = 0; i < insertRows.length; i += 500) {
    const batch = insertRows.slice(i, i + 500);
    const { error } = await supabase.from('inventory_transaction').insert(batch);
    if (error) {
      console.error('[inventoryTransaction] batch insert error:', error, '→ 개별 재시도');
      // 3) 배치 실패 시 1건씩 재시도
      for (const row of batch) {
        const { error: singleErr } = await supabase.from('inventory_transaction').insert(row);
        if (singleErr) {
          console.error('[inventoryTransaction] single insert fail:', row.sku_id, singleErr.message);
          failed++;
        } else {
          success++;
        }
        onProgress?.(success + failed, total);
      }
    } else {
      success += batch.length;
    }
    onProgress?.(success + failed, total);
  }

  // 4) inventory 테이블 자동 반영 (트랜잭션 → 현재 재고)
  if (success > 0) {
    await syncInventoryFromTransactions(valid, options?.allowNegative ?? false);
  }

  return { success, failed };
}

/**
 * 트랜잭션 기록 후 inventory 테이블에 재고 반영
 * @param allowNegative true면 음수 재고를 실제 DB에 저장 (-3, -5 등).
 *                      false(기본)면 Math.max(0, ...)로 0 이하 클램프.
 *                      사용자가 음수 재고 경고 모달에서 "계속 진행"을 선택한 경우에만 true 권장.
 */
async function syncInventoryFromTransactions(
  rows: RecordTxParams[],
  allowNegative: boolean = false
): Promise<void> {
  // SKU별 + needs_marking별 순변동 집계 (입고/반품 = +, 출고 = -)
  const deltaMap = new Map<string, { warehouseId: string; skuId: string; needsMarking: boolean; delta: number }>();
  for (const r of rows) {
    const nm = r.needsMarking ?? false;
    const key = `${r.warehouseId}|${r.skuId}|${nm}`;
    if (!deltaMap.has(key)) deltaMap.set(key, { warehouseId: r.warehouseId, skuId: r.skuId, needsMarking: nm, delta: 0 });
    const entry = deltaMap.get(key)!;
    switch (r.txType) {
      case '입고': entry.delta += r.quantity; break;
      case '이동입고': entry.delta += r.quantity; break;
      case '출고': entry.delta -= r.quantity; break;
      case '반품': entry.delta += r.quantity; break;
      case '재고조정': entry.delta += r.quantity; break;
      case '마킹출고': entry.delta -= r.quantity; break;
      case '마킹입고': entry.delta += r.quantity; break;
      case '판매': entry.delta -= r.quantity; break;
      case '기초재고': entry.delta += r.quantity; break;
    }
  }

  const entries = [...deltaMap.values()];
  // 500개씩 배치 처리
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500);
    const skuIds = batch.map((e) => e.skuId);

    // 현재 inventory 조회
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('warehouse_id, sku_id, needs_marking, quantity')
      .eq('warehouse_id', batch[0].warehouseId)
      .in('sku_id', skuIds);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.warehouse_id}|${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number])
    );

    // upsert 데이터 준비
    const upsertRows = batch.map((e) => {
      const currentQty = existingMap.get(`${e.warehouseId}|${e.skuId}|${e.needsMarking}`) || 0;
      const nextQty = currentQty + e.delta;
      return {
        warehouse_id: e.warehouseId,
        sku_id: e.skuId,
        needs_marking: e.needsMarking,
        // allowNegative=true 인 경우 실제 음수 저장, 아니면 0 이하 클램프
        quantity: allowNegative ? nextQty : Math.max(0, nextQty),
      };
    });

    const { error } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
    if (error) console.error('[inventoryTransaction] inventory upsert error:', error);
  }
}

/** CJ 엑셀 업로드 데이터 삭제 (유형 + 기간) + inventory 역반영 */
export async function deleteCjTransactions(params: {
  warehouseId: string;
  txType: TxType;
  startDate: string;
  endDate: string;
}): Promise<{ deleted: number; error: string | null }> {
  // 1) 삭제 대상 트랜잭션 조회 (페이지네이션으로 전체 조회 — 1,000건 제한 우회)
  const txToDelete: { sku_id: string; tx_type: string; quantity: number; needs_marking: boolean | null }[] = [];
  let offset = 0;
  while (true) {
    const { data: page, error: fetchErr } = await supabaseAdmin
      .from('inventory_transaction')
      .select('sku_id, tx_type, quantity, needs_marking')
      .eq('source', 'cj_excel')
      .eq('warehouse_id', params.warehouseId)
      .eq('tx_type', params.txType)
      .gte('tx_date', params.startDate)
      .lte('tx_date', params.endDate)
      .range(offset, offset + 999);
    if (fetchErr) return { deleted: 0, error: fetchErr.message };
    if (!page || page.length === 0) break;
    txToDelete.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  const deleteCount = txToDelete.length;
  if (deleteCount === 0) {
    return { deleted: 0, error: null };
  }

  // 2) 트랜잭션 삭제
  const { error } = await supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'cj_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (error) {
    return { deleted: 0, error: error.message };
  }

  // 3) inventory 역반영 (삭제된 트랜잭션의 반대 방향)
  const reverseDelta = new Map<string, { delta: number; needsMarking: boolean }>();
  for (const tx of txToDelete || []) {
    const nm = tx.needs_marking ?? false;
    const key = `${tx.sku_id}|${nm}`;
    if (!reverseDelta.has(key)) reverseDelta.set(key, { delta: 0, needsMarking: nm });
    const entry = reverseDelta.get(key)!;
    switch (tx.tx_type as TxType) {
      case '입고': entry.delta -= tx.quantity; break;
      case '이동입고': entry.delta -= tx.quantity; break;
      case '출고': entry.delta += tx.quantity; break;
      case '반품': entry.delta -= tx.quantity; break;
      case '재고조정': entry.delta -= tx.quantity; break;
      case '마킹출고': entry.delta += tx.quantity; break;
      case '마킹입고': entry.delta -= tx.quantity; break;
      case '판매': entry.delta += tx.quantity; break;
      case '기초재고': entry.delta -= tx.quantity; break;
    }
  }

  const deltaKeys = [...reverseDelta.keys()];
  const skuIds = [...new Set(deltaKeys.map((k) => k.split('|')[0]))];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, needs_marking, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number])
    );

    const upsertRows = deltaKeys
      .filter((k) => batch.includes(k.split('|')[0]))
      .map((key) => {
        const skuId = key.split('|')[0];
        const entry = reverseDelta.get(key)!;
        return {
          warehouse_id: params.warehouseId,
          sku_id: skuId,
          needs_marking: entry.needsMarking,
          quantity: Math.max(0, (existingMap.get(key) || 0) + entry.delta),
        };
      });

    const { error: upsertErr } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
    if (upsertErr) console.error('[inventoryTransaction] delete inventory reverse error:', upsertErr);
  }

  return { deleted: deleteCount, error: null };
}

/** system 소스 트랜잭션 삭제 (실적 삭제용) + inventory 역반영 */
export async function deleteSystemTransactions(params: {
  warehouseId: string;
  memo: string; // 정확 일치 (eq) 또는 LIKE 패턴 (memoLike 사용 시)
  memoLike?: string; // LIKE 패턴 (예: '%입고확인%작업지시서 2026-03-31%')
}): Promise<{ deleted: number; error: string | null }> {
  // 1) 삭제 대상 트랜잭션 조회
  let query = supabaseAdmin
    .from('inventory_transaction')
    .select('sku_id, tx_type, quantity, needs_marking')
    .eq('source', 'system')
    .eq('warehouse_id', params.warehouseId);
  if (params.memoLike) {
    query = query.like('memo', params.memoLike);
  } else {
    query = query.eq('memo', params.memo);
  }
  const { data: txToDelete, error: fetchErr } = await query;

  if (fetchErr) {
    return { deleted: 0, error: fetchErr.message };
  }

  const deleteCount = txToDelete?.length || 0;
  if (deleteCount === 0) {
    return { deleted: 0, error: null };
  }

  // 2) 트랜잭션 삭제
  let delQuery = supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'system')
    .eq('warehouse_id', params.warehouseId);
  if (params.memoLike) {
    delQuery = delQuery.like('memo', params.memoLike);
  } else {
    delQuery = delQuery.eq('memo', params.memo);
  }
  const { error } = await delQuery;

  if (error) {
    return { deleted: 0, error: error.message };
  }

  // 3) inventory 역반영 (삭제된 트랜잭션의 반대 방향)
  const reverseDelta = new Map<string, { delta: number; needsMarking: boolean }>();
  for (const tx of txToDelete || []) {
    const nm = tx.needs_marking ?? false;
    const key = `${tx.sku_id}|${nm}`;
    if (!reverseDelta.has(key)) reverseDelta.set(key, { delta: 0, needsMarking: nm });
    const entry = reverseDelta.get(key)!;
    switch (tx.tx_type as TxType) {
      case '입고': entry.delta -= tx.quantity; break;
      case '이동입고': entry.delta -= tx.quantity; break;
      case '출고': entry.delta += tx.quantity; break;
      case '반품': entry.delta -= tx.quantity; break;
      case '재고조정': entry.delta -= tx.quantity; break;
      case '마킹출고': entry.delta += tx.quantity; break;
      case '마킹입고': entry.delta -= tx.quantity; break;
      case '판매': entry.delta += tx.quantity; break;
      case '기초재고': entry.delta -= tx.quantity; break;
    }
  }

  const deltaKeys = [...reverseDelta.keys()];
  const skuIds = [...new Set(deltaKeys.map((k) => k.split('|')[0]))];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, needs_marking, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number])
    );

    const upsertRows = deltaKeys
      .filter((k) => batch.includes(k.split('|')[0]))
      .map((key) => {
        const skuId = key.split('|')[0];
        const entry = reverseDelta.get(key)!;
        return {
          warehouse_id: params.warehouseId,
          sku_id: skuId,
          needs_marking: entry.needsMarking,
          quantity: Math.max(0, (existingMap.get(key) || 0) + entry.delta),
        };
      });

    const { error: upsertErr } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
    if (upsertErr) console.error('[inventoryTransaction] delete system inventory reverse error:', upsertErr);
  }

  return { deleted: deleteCount, error: null };
}

/** CJ 엑셀 데이터 건수 조회 (삭제 미리보기용) */
export async function countCjTransactions(params: {
  warehouseId: string;
  txType: TxType;
  startDate: string;
  endDate: string;
}): Promise<number> {
  const { count } = await supabaseAdmin
    .from('inventory_transaction')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'cj_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);
  return count || 0;
}

/** POS 판매 데이터 삭제 (기간) + inventory 역반영 */
export async function deletePosTransactions(params: {
  warehouseId: string;
  startDate: string;
  endDate: string;
}): Promise<{ deleted: number; error: string | null }> {
  const { data: txToDelete, error: fetchErr } = await supabaseAdmin
    .from('inventory_transaction')
    .select('sku_id, tx_type, quantity, needs_marking')
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (fetchErr) return { deleted: 0, error: fetchErr.message };
  const deleteCount = txToDelete?.length || 0;
  if (deleteCount === 0) return { deleted: 0, error: null };

  const { error } = await supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);

  if (error) return { deleted: 0, error: error.message };

  // inventory 역반영 (판매 삭제 = 재고 복구)
  const reverseDelta = new Map<string, { delta: number; needsMarking: boolean }>();
  for (const tx of txToDelete || []) {
    const nm = tx.needs_marking ?? false;
    const key = `${tx.sku_id}|${nm}`;
    if (!reverseDelta.has(key)) reverseDelta.set(key, { delta: 0, needsMarking: nm });
    reverseDelta.get(key)!.delta += tx.quantity;
  }

  const deltaKeys = [...reverseDelta.keys()];
  const skuIds = [...new Set(deltaKeys.map((k) => k.split('|')[0]))];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, needs_marking, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number])
    );

    const upsertRows = deltaKeys
      .filter((k) => batch.includes(k.split('|')[0]))
      .map((key) => {
        const skuId = key.split('|')[0];
        const entry = reverseDelta.get(key)!;
        return {
          warehouse_id: params.warehouseId,
          sku_id: skuId,
          needs_marking: entry.needsMarking,
          quantity: Math.max(0, (existingMap.get(key) || 0) + entry.delta),
        };
      });

    await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
  }

  return { deleted: deleteCount, error: null };
}

/** POS 판매 데이터 건수 조회 */
export async function countPosTransactions(params: {
  warehouseId: string;
  startDate: string;
  endDate: string;
}): Promise<number> {
  const { count } = await supabaseAdmin
    .from('inventory_transaction')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'pos_excel')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', '판매')
    .gte('tx_date', params.startDate)
    .lte('tx_date', params.endDate);
  return count || 0;
}

/** 오프라인 수동 등록 삭제 미리보기 — SKU별 예상 재고 변동 반환 (읽기 전용) */
export async function previewOfflineManualDelete(params: {
  warehouseId: string;
  txType: TxType;
  txDate: string;
}): Promise<{
  count: number;
  preview: Array<{
    skuId: string;
    skuName: string;
    currentQty: number;
    deltaChange: number;
    afterQty: number;
  }>;
}> {
  // 1) 삭제 대상 트랜잭션 조회 (페이지네이션)
  const txRows: { sku_id: string; tx_type: string; quantity: number; needs_marking: boolean | null }[] = [];
  let offset = 0;
  while (true) {
    const { data: page, error: fetchErr } = await supabaseAdmin
      .from('inventory_transaction')
      .select('sku_id, tx_type, quantity, needs_marking')
      .eq('source', 'offline_manual')
      .eq('warehouse_id', params.warehouseId)
      .eq('tx_type', params.txType)
      .eq('tx_date', params.txDate)
      .range(offset, offset + 999);
    if (fetchErr || !page || page.length === 0) break;
    txRows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  if (txRows.length === 0) {
    return { count: 0, preview: [] };
  }

  // 2) SKU별 역delta 계산
  const reverseDelta = new Map<string, { delta: number; needsMarking: boolean }>();
  for (const tx of txRows) {
    const nm = tx.needs_marking ?? false;
    const key = `${tx.sku_id}|${nm}`;
    if (!reverseDelta.has(key)) reverseDelta.set(key, { delta: 0, needsMarking: nm });
    const entry = reverseDelta.get(key)!;
    switch (tx.tx_type as TxType) {
      case '입고': entry.delta -= tx.quantity; break;
      case '이동입고': entry.delta -= tx.quantity; break;
      case '출고': entry.delta += tx.quantity; break;
      case '반품': entry.delta -= tx.quantity; break;
      case '재고조정': entry.delta -= tx.quantity; break;
      case '마킹출고': entry.delta += tx.quantity; break;
      case '마킹입고': entry.delta -= tx.quantity; break;
      case '판매': entry.delta += tx.quantity; break;
      case '기초재고': entry.delta -= tx.quantity; break;
    }
  }

  // 3) 현재 inventory 수량 조회
  const skuIds = [...new Set([...reverseDelta.keys()].map((k) => k.split('|')[0]))];
  const existingMap = new Map<string, number>();
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, needs_marking, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);
    for (const e of existing || []) {
      existingMap.set(`${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number);
    }
  }

  // 4) SKU명 조회
  const skuNameMap = new Map<string, string>();
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: skuData } = await supabaseAdmin
      .from('sku')
      .select('sku_id, sku_name')
      .in('sku_id', batch);
    for (const s of skuData || []) {
      skuNameMap.set(s.sku_id, s.sku_name || s.sku_id);
    }
  }

  // 5) preview 배열 생성
  const preview = [...reverseDelta.entries()].map(([key, entry]) => {
    const skuId = key.split('|')[0];
    const currentQty = existingMap.get(key) || 0;
    return {
      skuId,
      skuName: skuNameMap.get(skuId) || skuId,
      currentQty,
      deltaChange: entry.delta,
      afterQty: currentQty + entry.delta,
    };
  });

  return { count: txRows.length, preview };
}

/** 오프라인 수동 등록 삭제 + inventory 역반영 (★ 역반영 먼저, 삭제 나중) */
export async function deleteOfflineManualTransactions(params: {
  warehouseId: string;
  txType: TxType;
  txDate: string;
}): Promise<{ deleted: number; error: string | null }> {
  // 1) 삭제 대상 트랜잭션 조회 (페이지네이션)
  const txToDelete: { sku_id: string; tx_type: string; quantity: number; needs_marking: boolean | null }[] = [];
  let offset = 0;
  while (true) {
    const { data: page, error: fetchErr } = await supabaseAdmin
      .from('inventory_transaction')
      .select('sku_id, tx_type, quantity, needs_marking')
      .eq('source', 'offline_manual')
      .eq('warehouse_id', params.warehouseId)
      .eq('tx_type', params.txType)
      .eq('tx_date', params.txDate)
      .range(offset, offset + 999);
    if (fetchErr) return { deleted: 0, error: fetchErr.message };
    if (!page || page.length === 0) break;
    txToDelete.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }

  const deleteCount = txToDelete.length;
  if (deleteCount === 0) {
    return { deleted: 0, error: null };
  }

  // 2) SKU별 역delta 계산
  const reverseDelta = new Map<string, { delta: number; needsMarking: boolean }>();
  for (const tx of txToDelete) {
    const nm = tx.needs_marking ?? false;
    const key = `${tx.sku_id}|${nm}`;
    if (!reverseDelta.has(key)) reverseDelta.set(key, { delta: 0, needsMarking: nm });
    const entry = reverseDelta.get(key)!;
    switch (tx.tx_type as TxType) {
      case '입고': entry.delta -= tx.quantity; break;
      case '이동입고': entry.delta -= tx.quantity; break;
      case '출고': entry.delta += tx.quantity; break;
      case '반품': entry.delta -= tx.quantity; break;
      case '재고조정': entry.delta -= tx.quantity; break;
      case '마킹출고': entry.delta += tx.quantity; break;
      case '마킹입고': entry.delta -= tx.quantity; break;
      case '판매': entry.delta += tx.quantity; break;
      case '기초재고': entry.delta -= tx.quantity; break;
    }
  }

  // 3) ★ inventory 역반영 먼저 (음수 허용 — Math.max 미적용)
  const deltaKeys = [...reverseDelta.keys()];
  const skuIds = [...new Set(deltaKeys.map((k) => k.split('|')[0]))];
  for (let i = 0; i < skuIds.length; i += 500) {
    const batch = skuIds.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from('inventory')
      .select('sku_id, needs_marking, quantity')
      .eq('warehouse_id', params.warehouseId)
      .in('sku_id', batch);

    const existingMap = new Map(
      (existing || []).map((e) => [`${e.sku_id}|${e.needs_marking ?? false}`, e.quantity as number])
    );

    const upsertRows = deltaKeys
      .filter((k) => batch.includes(k.split('|')[0]))
      .map((key) => {
        const skuId = key.split('|')[0];
        const entry = reverseDelta.get(key)!;
        return {
          warehouse_id: params.warehouseId,
          sku_id: skuId,
          needs_marking: entry.needsMarking,
          quantity: (existingMap.get(key) || 0) + entry.delta,
        };
      });

    const { error: upsertErr } = await supabaseAdmin
      .from('inventory')
      .upsert(upsertRows, { onConflict: 'warehouse_id,sku_id,needs_marking' });
    if (upsertErr) {
      return { deleted: 0, error: `재고 역반영 실패: ${upsertErr.message}` };
    }
  }

  // 4) 역반영 성공 후 트랜잭션 삭제
  const { error } = await supabaseAdmin
    .from('inventory_transaction')
    .delete()
    .eq('source', 'offline_manual')
    .eq('warehouse_id', params.warehouseId)
    .eq('tx_type', params.txType)
    .eq('tx_date', params.txDate);

  if (error) {
    return { deleted: 0, error: error.message };
  }

  return { deleted: deleteCount, error: null };
}
