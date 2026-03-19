import * as XLSX from 'xlsx';
import { supabaseAdmin } from './supabaseAdmin';

export interface PosSaleItem {
  barcode: string;
  posProductCode: string;
  productName: string;
  category: string;
  quantity: number;
  totalSales: number;
  netSales: number;
}

export interface PosParseResult {
  items: PosSaleItem[];
  saleDate: string;
  filename: string;
}

export interface PosMatchResult {
  item: PosSaleItem;
  skuId: string;
  skuName: string;
}

/** 파일명에서 날짜 추출: "...._YYMMDD.xlsx" → "20YY-MM-DD" */
export function extractDateFromPosFilename(filename: string): string | null {
  const match = filename.match(/_(\d{6})\./);
  if (!match) return null;
  const yymmdd = match[1];
  return `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

/** "상품별" 시트에서 판매 데이터 파싱 */
export function parsePosExcel(wb: XLSX.WorkBook): PosSaleItem[] {
  const sheetName = wb.SheetNames.find((n) => n.includes('상품별'));
  if (!sheetName) throw new Error('"상품별" 시트를 찾을 수 없습니다.');

  const ws = wb.Sheets[sheetName];
  const data: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (data.length < 2) return [];

  // 헤더 행 찾기 (바코드 컬럼 포함 행)
  let headerIdx = -1;
  let colMap: Record<string, number> = {};
  for (let i = 0; i < Math.min(5, data.length); i++) {
    const row = data[i];
    if (!row) continue;
    const idx = row.findIndex((c) => String(c || '').includes('바코드'));
    if (idx >= 0) {
      headerIdx = i;
      for (let j = 0; j < row.length; j++) {
        const h = String(row[j] || '').trim();
        if (h) colMap[h] = j;
      }
      break;
    }
  }
  if (headerIdx < 0) throw new Error('헤더 행을 찾을 수 없습니다 (바코드 컬럼 없음).');

  const catCol = colMap['품목'] ?? -1;
  const codeCol = colMap['상품코드'] ?? -1;
  const bcCol = colMap['바코드'] ?? -1;
  const nameCol = colMap['상품명'] ?? -1;
  const qtyCol = colMap['수량'] ?? -1;
  const salesCol = colMap['총매출액'] ?? -1;
  const netCol = colMap['실매출액'] ?? -1;

  if (bcCol < 0 || qtyCol < 0) throw new Error('바코드 또는 수량 컬럼을 찾을 수 없습니다.');

  const items: PosSaleItem[] = [];
  let currentCategory = '';

  for (let i = headerIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;

    // 품목(카테고리) carry-forward
    const cat = catCol >= 0 ? String(row[catCol] || '').trim() : '';
    if (cat) currentCategory = cat;

    const barcode = String(row[bcCol] || '').trim();
    if (!barcode) continue;

    const qty = Math.abs(Number(row[qtyCol]) || 0);
    if (qty <= 0) continue;

    items.push({
      barcode,
      posProductCode: codeCol >= 0 ? String(row[codeCol] || '').trim() : '',
      productName: nameCol >= 0 ? String(row[nameCol] || '').trim() : '',
      category: currentCategory,
      quantity: qty,
      totalSales: salesCol >= 0 ? Number(row[salesCol]) || 0 : 0,
      netSales: netCol >= 0 ? Number(row[netCol]) || 0 : 0,
    });
  }

  return items;
}

/** 바코드 → SKU 매칭 (sku.barcode로 일괄 조회) */
export async function matchPosBarcodes(
  items: PosSaleItem[]
): Promise<{ matched: PosMatchResult[]; unmatched: PosSaleItem[] }> {
  const uniqueBarcodes = [...new Set(items.map((i) => i.barcode))];
  const bcToSku = new Map<string, { skuId: string; skuName: string }>();

  for (let i = 0; i < uniqueBarcodes.length; i += 500) {
    const batch = uniqueBarcodes.slice(i, i + 500);
    const { data } = await supabaseAdmin
      .from('sku')
      .select('sku_id, sku_name, barcode')
      .in('barcode', batch);
    if (data) {
      for (const row of data) {
        if (row.barcode) bcToSku.set(row.barcode, { skuId: row.sku_id, skuName: row.sku_name });
      }
    }
  }

  const matched: PosMatchResult[] = [];
  const unmatched: PosSaleItem[] = [];

  for (const item of items) {
    const sku = bcToSku.get(item.barcode);
    if (sku) {
      matched.push({ item, skuId: sku.skuId, skuName: sku.skuName });
    } else {
      unmatched.push(item);
    }
  }

  return { matched, unmatched };
}
