import * as XLSX from 'xlsx';

interface TransferLine {
  skuId: string;
  skuName: string;
  quantity: number;
}

interface InventoryAdjLine {
  skuId: string;       // BERRIZ 숫자형 SKU ID
  warehouseId: string;
  quantity: number;
  code: 'M' | 'P';    // M=차감, P=증가
  reason: string;      // 조정사유코드 (ETC)
  memo: string;        // 비고
  skuCode: string;     // SKU코드 (26UN-...)
  skuName: string;     // 상품명
}

interface CjReceiptLine {
  deliveryWarehouseId: string;
  skuId: string;
  skuName: string;
  quantity: number;
  receiptType: 'G' | 'P'; // G=일반입고, P=생산입고
  requestDate: string;
}

function downloadWorkbook(wb: XLSX.WorkBook, filename: string) {
  XLSX.writeFile(wb, filename);
}

// ① 이관지시서
export function exportTransferOrder(
  lines: TransferLine[],
  date: string,
  fromWarehouseName: string,
  toWarehouseName: string
) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['출고창고', '입고창고', 'SKU ID', 'SKU명', '수량'],
    ...lines.map((l) => [fromWarehouseName, toWarehouseName, l.skuId, l.skuName, l.quantity]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '이관지시서');
  downloadWorkbook(wb, `이관지시서_${date}.xlsx`);
}

// ② 재고조정양식 (오프라인샵 M차감) - PPT 27p
// ③ 재고조정양식 (제작창고 P증가)   - PPT 29p
// ④ 재고조정양식 (제작창고 M차감)   - PPT 31p
export function exportInventoryAdjustment(
  lines: InventoryAdjLine[],
  date: string,
  suffix: string
) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['SKU ID', '창고 ID', '조정수량', '증가(P)/차감(M)', '조정사유코드(AdjustmentReason)', '비고', 'SKU코드', '상품명'],
    ...lines.map((l) => [l.skuId, l.warehouseId, l.quantity, l.code, l.reason, l.memo, l.skuCode, l.skuName]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '재고조정양식');
  downloadWorkbook(wb, `재고조정양식_${suffix}_${date}.xlsx`);
}

// ⑤ CJ창고 입고요청양식 G타입 - PPT 32p
export function exportCjReceiptRequest(
  lines: CjReceiptLine[],
  date: string
) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['출고지 ID', 'SKU ID', 'SKU명', '수량', '입고유형', '입고요청일'],
    ...lines.map((l) => [
      l.deliveryWarehouseId,
      l.skuId,
      l.skuName,
      l.quantity,
      l.receiptType,
      l.requestDate,
    ]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '(CJ창고 입고)입고요청 양식');
  downloadWorkbook(wb, `CJ창고입고요청_${date}.xlsx`);
}

// ⑥ 생산입고요청양식 P타입
export function exportProductionReceiptRequest(
  lines: CjReceiptLine[],
  date: string
) {
  const ws = XLSX.utils.aoa_to_sheet([
    ['출고지 ID', 'SKU ID', 'SKU명', '수량', '입고유형', '입고요청일'],
    ...lines.map((l) => [
      l.deliveryWarehouseId,
      l.skuId,
      l.skuName,
      l.quantity,
      'P',
      l.requestDate,
    ]),
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '생산입고요청 양식');
  downloadWorkbook(wb, `생산입고요청_${date}.xlsx`);
}

// 전체 양식을 하나의 엑셀 파일로 묶어서 내보내기
export function exportAllForms(params: {
  transferLines: TransferLine[];
  offlineAdjLines: InventoryAdjLine[];
  date: string;
  fromWarehouseName: string;
  toWarehouseName: string;
}) {
  const { transferLines, offlineAdjLines, date, fromWarehouseName, toWarehouseName } = params;
  const wb = XLSX.utils.book_new();

  // 이관지시서 시트
  const wsTransfer = XLSX.utils.aoa_to_sheet([
    ['출고창고', '입고창고', 'SKU ID', 'SKU명', '수량'],
    ...transferLines.map((l) => [fromWarehouseName, toWarehouseName, l.skuId, l.skuName, l.quantity]),
  ]);
  XLSX.utils.book_append_sheet(wb, wsTransfer, '이관지시서');

  // 재고조정 시트 (오프라인 M차감)
  const wsAdj = XLSX.utils.aoa_to_sheet([
    ['SKU ID', '창고 ID', '조정수량', '증가(P)/차감(M)', '조정사유코드(AdjustmentReason)', '비고', 'SKU코드', '상품명'],
    ...offlineAdjLines.map((l) => [l.skuId, l.warehouseId, l.quantity, l.code, l.reason, l.memo, l.skuCode, l.skuName]),
  ]);
  XLSX.utils.book_append_sheet(wb, wsAdj, '재고조정양식');

  downloadWorkbook(wb, `STEP1_양식_${date}.xlsx`);
}

export type { TransferLine, InventoryAdjLine, CjReceiptLine };
