-- =============================================
-- 마킹 제작 재고 관리 시스템 - Supabase 스키마
-- Supabase > SQL Editor 에 복사해서 실행하세요
-- =============================================

-- 1. SKU 마스터
create table if not exists sku (
  sku_id text primary key,
  sku_name text not null,
  barcode text,
  type text not null check (type in ('완제품', '유니폼단품', '마킹단품')),
  created_at timestamptz default now()
);

-- 2. BOM (완제품 → 구성 단품 매핑)
create table if not exists bom (
  id uuid primary key default gen_random_uuid(),
  finished_sku_id text not null references sku(sku_id),
  component_sku_id text not null references sku(sku_id),
  quantity int not null default 1,
  created_at timestamptz default now(),
  unique (finished_sku_id, component_sku_id)
);

-- 3. 창고
create table if not exists warehouse (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  external_id text not null default '',  -- BERRIZ 창고 ID
  created_at timestamptz default now()
);

-- 기본 창고 데이터 삽입
insert into warehouse (name, external_id) values
  ('오프라인샵', ''),
  ('플레이위즈', ''),
  ('CJ창고', '')
on conflict (name) do nothing;

-- 4. 창고별 재고
create table if not exists inventory (
  warehouse_id uuid not null references warehouse(id),
  sku_id text not null references sku(sku_id),
  quantity int not null default 0,
  updated_at timestamptz default now(),
  primary key (warehouse_id, sku_id)
);

-- 5. 작업지시서
create table if not exists work_order (
  id uuid primary key default gen_random_uuid(),
  uploaded_at timestamptz default now(),
  download_date date not null,
  status text not null default '업로드됨' check (
    status in ('업로드됨', '이관준비', '이관중', '입고확인완료', '마킹중', '마킹완료', '출고완료')
  )
);

-- 6. 작업지시서 라인
create table if not exists work_order_line (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references work_order(id) on delete cascade,
  finished_sku_id text not null references sku(sku_id),
  ordered_qty int not null default 0,
  sent_qty int not null default 0,
  received_qty int not null default 0,
  marked_qty int not null default 0,
  needs_marking boolean not null default false
);

-- 7. 일별 마킹 작업 기록
create table if not exists daily_marking (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  work_order_line_id uuid not null references work_order_line(id),
  completed_qty int not null default 0,
  sent_to_cj_qty int not null default 0,
  created_at timestamptz default now()
);

-- 8. 사용자 프로필 (역할 관리)
create table if not exists user_profile (
  id uuid primary key references auth.users(id),
  name text not null,
  role text not null check (role in ('admin', 'offline', 'playwith')),
  created_at timestamptz default now()
);

-- 9. 활동 로그 (각 화면 작업 이력)
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  action_type text not null check (
    action_type in ('shipment_confirm', 'receipt_check', 'marking_work', 'shipment_out')
  ),
  work_order_id uuid references work_order(id),
  action_date date not null default current_date,
  summary jsonb not null default '{}',
  created_at timestamptz default now()
);

create index if not exists idx_activity_log_user_date on activity_log (user_id, action_date);
create index if not exists idx_activity_log_action_date on activity_log (action_date, action_type);

-- =============================================
-- Row Level Security (RLS) 설정
-- =============================================

alter table sku enable row level security;
alter table bom enable row level security;
alter table warehouse enable row level security;
alter table inventory enable row level security;
alter table work_order enable row level security;
alter table work_order_line enable row level security;
alter table daily_marking enable row level security;
alter table user_profile enable row level security;
alter table activity_log enable row level security;

-- 인증된 사용자는 모두 읽기 가능
create policy "authenticated_read_sku" on sku for select using (auth.role() = 'authenticated');
create policy "authenticated_read_bom" on bom for select using (auth.role() = 'authenticated');
create policy "authenticated_read_warehouse" on warehouse for select using (auth.role() = 'authenticated');
create policy "authenticated_read_inventory" on inventory for select using (auth.role() = 'authenticated');
create policy "authenticated_read_work_order" on work_order for select using (auth.role() = 'authenticated');
create policy "authenticated_read_work_order_line" on work_order_line for select using (auth.role() = 'authenticated');
create policy "authenticated_read_daily_marking" on daily_marking for select using (auth.role() = 'authenticated');
create policy "authenticated_read_user_profile" on user_profile for select using (auth.uid() = id);

-- 쓰기 권한 (인증된 사용자 전체 허용 - 역할 제한은 앱 레이어에서 처리)
create policy "authenticated_write_sku" on sku for all using (auth.role() = 'authenticated');
create policy "authenticated_write_bom" on bom for all using (auth.role() = 'authenticated');
create policy "authenticated_write_warehouse" on warehouse for all using (auth.role() = 'authenticated');
create policy "authenticated_write_inventory" on inventory for all using (auth.role() = 'authenticated');
create policy "authenticated_write_work_order" on work_order for all using (auth.role() = 'authenticated');
create policy "authenticated_write_work_order_line" on work_order_line for all using (auth.role() = 'authenticated');
create policy "authenticated_write_daily_marking" on daily_marking for all using (auth.role() = 'authenticated');
create policy "authenticated_write_user_profile" on user_profile for all using (auth.uid() = id);
create policy "authenticated_read_activity_log" on activity_log for select using (auth.role() = 'authenticated');
create policy "authenticated_write_activity_log" on activity_log for all using (auth.role() = 'authenticated');
