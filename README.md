# 마킹 제작 재고 관리 시스템

BERRIZ 유니폼 마킹 주문의 오프라인샵 → 플레이위즈 → CJ창고 흐름을 전산 관리하는 웹 애플리케이션.

---

## 시작하기

### 1. Supabase 프로젝트 생성

1. [supabase.com](https://supabase.com) 에서 무료 계정 생성
2. "New Project" 클릭
3. **Settings > API** 에서 `Project URL` 과 `anon public` 키 복사

### 2. 데이터베이스 스키마 생성

1. Supabase 대시보드 → **SQL Editor**
2. `supabase_schema.sql` 파일 전체 복사 → 붙여넣기 → **Run**

### 3. 사용자 계정 생성

1. **Authentication > Users** → "Invite User" 로 담당자별 계정 생성
2. **SQL Editor** 에서 역할 등록 (id는 Users 목록에서 확인):

```sql
INSERT INTO user_profile (id, name, role) VALUES
  ('관리자-uuid', '관리자', 'admin'),
  ('오프라인-uuid', '오프라인매장', 'offline'),
  ('플레이위즈-uuid', '플레이위즈', 'playwith');
```

### 4. BERRIZ 창고 ID 등록

```sql
UPDATE warehouse SET external_id = 'BERRIZ창고ID' WHERE name = '오프라인샵';
UPDATE warehouse SET external_id = 'BERRIZ창고ID' WHERE name = '플레이위즈';
UPDATE warehouse SET external_id = 'BERRIZ창고ID' WHERE name = 'CJ창고';
```

### 5. 환경 변수 설정

```bash
cp .env.local.example .env.local
# .env.local 파일에 Supabase URL과 키 입력
```

### 6. 실행

```bash
npm install
npm run dev
# http://localhost:5173 접속
```

---

## 배포 (Vercel - 무료)

1. [vercel.com](https://vercel.com) 가입 → GitHub 저장소 연결
2. Environment Variables에 `.env.local` 내용 추가
3. Deploy

---

## 역할별 화면

| 역할 | 접근 가능 메뉴 | 하는 일 |
|------|------------|---------|
| 관리자 | 대시보드, 작업지시서 업로드, 양식 다운로드, BOM 관리 | 작업지시서 처리 + BERRIZ 양식 업로드 |
| 오프라인 매장 | 발송 확인 | 발송 목록 확인 후 완료 버튼 클릭 |
| 플레이위즈 | 입고 확인, 마킹 작업 | 수량 입력 |

---

## 업무 흐름

```
[관리자] 작업지시서 업로드
  → STEP1 양식 다운로드 (이관지시서 + 재고조정 M) → BERRIZ 업로드

[오프라인샵] 발송 완료 확인 클릭

[플레이위즈] 입고 수량 확인 완료
  → STEP2 양식 다운로드 (재고조정 P) → BERRIZ 업로드

[플레이위즈] 당일 마킹 수량 입력 저장 (미완료 자동 이월)
  → STEP3 양식 다운로드 (재고조정 M + CJ입고요청G + 생산입고요청P) → BERRIZ 업로드
```

---

## BOM 엑셀 양식

헤더 포함, 아래 순서로 작성:

| 완제품 SKU ID | 완제품 SKU명 | 단품 SKU ID | 단품 SKU명 | 수량 |
|-------------|------------|------------|----------|------|
| SKU-001 | 구자욱 유니폼 95 | UNI-95 | 유니폼 95 | 1 |
| SKU-001 | 구자욱 유니폼 95 | MRK-GJW | 마킹-구자욱 | 1 |
