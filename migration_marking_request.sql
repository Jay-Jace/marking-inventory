-- marking_request 테이블 생성 (수기 마킹 요청)
CREATE TABLE IF NOT EXISTS marking_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID NOT NULL REFERENCES auth.users(id),
  requested_at TIMESTAMPTZ DEFAULT now(),
  request_date DATE NOT NULL DEFAULT current_date,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  items JSONB NOT NULL,
  completed_by UUID REFERENCES auth.users(id),
  completed_at TIMESTAMPTZ,
  completion_summary JSONB,
  notes TEXT
);

-- RLS
ALTER TABLE marking_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_marking_request" ON marking_request FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "svc_all_marking_request" ON marking_request FOR ALL TO service_role USING (true) WITH CHECK (true);
