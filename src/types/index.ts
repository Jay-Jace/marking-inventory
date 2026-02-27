export type SkuType = '완제품' | '유니폼단품' | '마킹단품';

export interface Sku {
  sku_id: string;
  sku_name: string;
  barcode: string | null;
  type: SkuType;
}

export interface BomItem {
  id: string;
  finished_sku_id: string;
  component_sku_id: string;
  quantity: number;
  component?: Sku;
}

export interface Warehouse {
  id: string;
  name: string;
  external_id: string; // BERRIZ 창고 ID
}

export interface Inventory {
  warehouse_id: string;
  sku_id: string;
  quantity: number;
  sku?: Sku;
  warehouse?: Warehouse;
}

export type WorkOrderStatus =
  | '업로드됨'
  | '이관준비'
  | '이관중'
  | '입고확인완료'
  | '마킹중'
  | '마킹완료'
  | '출고완료';

export interface WorkOrder {
  id: string;
  uploaded_at: string;
  download_date: string;
  status: WorkOrderStatus;
  lines?: WorkOrderLine[];
}

export interface WorkOrderLine {
  id: string;
  work_order_id: string;
  finished_sku_id: string;
  ordered_qty: number;
  sent_qty: number;
  received_qty: number;
  marked_qty: number;
  needs_marking: boolean;
  finished_sku?: Sku;
  bom_components?: BomItem[];
}

export interface DailyMarking {
  id: string;
  date: string;
  work_order_line_id: string;
  completed_qty: number;
  sent_to_cj_qty: number;
  line?: WorkOrderLine;
}

export type UserRole = 'admin' | 'offline' | 'playwith';

export interface AppUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}
