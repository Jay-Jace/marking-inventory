import * as XLSX from 'xlsx';
import type { TxType } from '../types';

export interface OfflineStockTransaction {
  barcode: string;
  skuName: string;
  date: string;       // YYYY-MM-DD
  quantity: number;
  type: TxType;       // 기초재고 | 입고 | 판매 | 재고조정
}

export interface OfflineStockParseResult {
  transactions: OfflineStockTransaction[];
  dateRange: { min: string; max: string };
  productCount: number;
  summary: Record<string, number>; // type별 건수
}

/**
 * 매장수불 스프레드시트 헤더 구조:
 * Row 1: (빈) (빈) 3-16 3-16 3-16 3-16 3-16 3-16 3-17 3-17 ...
 * Row 2: 바코드 품목 기초 입고 출고 이동출고 조정 마감 기초 입고 ...
 * Row 3: (합계)
 * Row 4+: 데이터 (바코드, 품목명, 수량들...)
 *
 * 날짜별 컬럼 패턴 (6컬럼 반복): 기초/입고/출고/이동출고/조정/마감
 * - 기초: 최초 날짜만 기초재고로 사용
 * - 입고: tx_type='입고'
 * - 출고: tx_type='판매' (매장 판매)
 * - 이동출고: skip (이미 system으로 기록됨)
 * - 조정: tx_type='재고조정'
 * - 마감: skip (계산값)
 */

// 날짜별 컬럼 유형
const COL_TYPES = ['기초', '입고', '출고', '이동출고', '조정', '마감'] as const;

/**
 * 헤더 날짜 파싱 — Excel 시리얼 번호 또는 "3-16" 문자열 모두 지원
 * Excel 시리얼: 46097 = 2026-03-16 (epoch: 1900-01-00 기준)
 */
function parseDateHeader(val: any): string | null {
  if (val === '' || val == null) return null;

  // 숫자(Excel 시리얼 번호) — XLSX 내장 파서 사용
  if (typeof val === 'number' && val > 40000 && val < 60000) {
    const parsed = XLSX.SSF.parse_date_code(val);
    const mm = String(parsed.m).padStart(2, '0');
    const dd = String(parsed.d).padStart(2, '0');
    return `${parsed.y}-${mm}-${dd}`;
  }

  // "3-16" 문자열 패턴
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const month = m[1].padStart(2, '0');
    const day = m[2].padStart(2, '0');
    return `2026-${month}-${day}`;
  }

  return null;
}

export function parseOfflineStockExcel(wb: XLSX.WorkBook): OfflineStockParseResult {
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (raw.length < 4) {
    throw new Error('데이터가 부족합니다. 최소 4행(헤더 2행 + 합계 + 데이터 1행) 필요합니다.');
  }

  const row1 = raw[0]; // 날짜 행
  const row2 = raw[1]; // 유형 행 (기초/입고/출고/이동출고/조정/마감)

  // 날짜-컬럼 매핑 구축
  interface DateCol {
    date: string;
    colIndex: number;
    colType: string; // 기초|입고|출고|이동출고|조정|마감
  }

  const dateCols: DateCol[] = [];
  let currentDate = '';

  for (let c = 2; c < row1.length; c++) {
    const dateVal = parseDateHeader(String(row1[c] || ''));
    if (dateVal) currentDate = dateVal;
    if (!currentDate) continue;

    const typeVal = String(row2[c] || '').trim();
    if (COL_TYPES.includes(typeVal as any)) {
      dateCols.push({ date: currentDate, colIndex: c, colType: typeVal });
    }
  }

  if (dateCols.length === 0) {
    throw new Error('날짜/유형 헤더를 찾을 수 없습니다. 1행에 "3-16" 형식, 2행에 "기초/입고/출고/이동출고/조정/마감"이 있어야 합니다.');
  }

  // 최초 날짜 (기초재고용)
  const allDates = [...new Set(dateCols.map((d) => d.date))].sort();
  const firstDate = allDates[0];

  // 데이터 행 파싱 (4행부터 = index 3)
  const transactions: OfflineStockTransaction[] = [];
  const barcodes = new Set<string>();

  for (let r = 3; r < raw.length; r++) {
    const row = raw[r];
    const barcode = String(row[0] || '').trim();
    const skuName = String(row[1] || '').trim();

    if (!barcode || barcode === '바코드' || barcode === '0') continue; // 빈 행 또는 헤더 반복 skip

    barcodes.add(barcode);

    for (const dc of dateCols) {
      const val = Number(row[dc.colIndex]) || 0;
      if (val === 0) continue; // 0이면 skip

      switch (dc.colType) {
        case '기초':
          // 최초 날짜의 기초만 넣음
          if (dc.date === firstDate && val > 0) {
            transactions.push({
              barcode, skuName, date: dc.date,
              quantity: val, type: '기초재고',
            });
          }
          break;
        case '입고':
          if (val > 0) {
            transactions.push({
              barcode, skuName, date: dc.date,
              quantity: val, type: '입고',
            });
          }
          break;
        case '출고':
          // 매장 판매
          if (val > 0) {
            transactions.push({
              barcode, skuName, date: dc.date,
              quantity: val, type: '판매',
            });
          }
          break;
        case '이동출고':
          // skip — 이미 system으로 기록됨
          break;
        case '조정':
          // 양수/음수 모두 가능
          transactions.push({
            barcode, skuName, date: dc.date,
            quantity: val, type: '재고조정',
          });
          break;
        case '마감':
          // skip — 계산값
          break;
      }
    }
  }

  // 요약
  const summary: Record<string, number> = {};
  for (const tx of transactions) {
    summary[tx.type] = (summary[tx.type] || 0) + 1;
  }

  const txDates = transactions.map((t) => t.date).sort();

  return {
    transactions,
    dateRange: {
      min: txDates[0] || firstDate,
      max: txDates[txDates.length - 1] || allDates[allDates.length - 1],
    },
    productCount: barcodes.size,
    summary,
  };
}
