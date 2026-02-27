import * as XLSX from 'xlsx';

export interface ParsedWorkOrder {
  downloadDate: string;
  lines: RawOrderLine[];
}

export interface RawOrderLine {
  bizPartnerId: string;
  deliveryId: string;
  manufacturerId: string;
  productName: string;
  productId: string;
  option1: string;
  option2: string;
  option3: string;
  skuName: string;
  skuCode: string;
  barcode: string;
  skuId: string;
  quantity: number;
}

/**
 * BERRIZ 작업지시서 엑셀 파싱 (출고수량 시트 기준)
 */
export function parseWorkOrderExcel(file: File): Promise<ParsedWorkOrder> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });

        // "출고수량" 시트 찾기
        const sheetName =
          workbook.SheetNames.find((n) => n.includes('출고수량')) ||
          workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
        });

        if (rows.length < 2) {
          reject(new Error('출고수량 시트에 데이터가 없습니다.'));
          return;
        }

        // 파일명에서 날짜 추출 (WorkOrder_YYYYMMDD-YYYYMMDD_YYYYMMDDHHII.xlsx)
        const downloadDate = new Date().toISOString().split('T')[0];

        const lines: RawOrderLine[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row[11] || !row[12]) continue; // SKU ID나 수량 없으면 스킵
          lines.push({
            bizPartnerId: String(row[0] || ''),
            deliveryId: String(row[1] || ''),
            manufacturerId: String(row[2] || ''),
            productName: String(row[3] || ''),
            productId: String(row[4] || ''),
            option1: String(row[5] || ''),
            option2: String(row[6] || ''),
            option3: String(row[7] || ''),
            skuName: String(row[8] || ''),
            skuCode: String(row[9] || ''),
            barcode: String(row[10] || ''),
            skuId: String(row[11] || ''),
            quantity: Number(row[12]) || 0,
          });
        }

        resolve({ downloadDate, lines });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export interface RawBomRow {
  finishedSkuId: string;
  finishedSkuName: string;
  componentSkuId: string;
  componentSkuName: string;
  quantity: number;
}

/**
 * BOM 엑셀 파싱
 * 컬럼 순서: 완제품 SKU ID | 완제품 SKU명 | 단품 SKU ID | 단품 SKU명 | 수량
 */
export function parseBomExcel(file: File): Promise<RawBomRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: '',
        });

        const result: RawBomRow[] = [];
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row[0] || !row[2]) continue;
          result.push({
            finishedSkuId: String(row[0]),
            finishedSkuName: String(row[1] || ''),
            componentSkuId: String(row[2]),
            componentSkuName: String(row[3] || ''),
            quantity: Number(row[4]) || 1,
          });
        }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
