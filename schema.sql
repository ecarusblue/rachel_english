-- 영어 공부방 진도표 관리 앱 - Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 Run 하세요.
-- 여러 번 실행해도 오류가 나지 않도록 작성되어 있습니다.

-- ============================================================
-- 1. 테이블
-- ============================================================

create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 50),
  grade       text,                       -- 예: 초5, 중2
  started_on  date,                       -- 등록일
  active      boolean not null default true,
  memo        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.textbooks (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 100),
  total_units  integer not null default 1 check (total_units between 1 and 500),
  unit_label   text not null default 'Unit',   -- Unit, Lesson, Chapter 등
  created_at   timestamptz not null default now()
);

-- 학생별 교재 진도 (학생 x 교재 당 1행)
create table if not exists public.progress (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id    uuid not null references public.students(id) on delete cascade,
  textbook_id   uuid not null references public.textbooks(id) on delete cascade,
  current_unit  integer not null default 0 check (current_unit >= 0),
  updated_at    timestamptz not null default now(),
  unique (student_id, textbook_id)
);

-- 수업 기록: 출결 + 숙제 + 메모
create table if not exists public.lessons (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  lesson_date  date not null default current_date,
  attendance   text not null default '출석' check (attendance in ('출석','지각','결석','보강')),
  homework     text check (homework in ('완료','일부','미제출')),
  memo         text,
  -- 수업 진도: 이번 수업에서 나간 교재와 단원 범위, 학습 내용, 다음 수업 예정 진도
  textbook_id  uuid references public.textbooks(id) on delete set null,
  from_unit    integer check (from_unit >= 0),
  to_unit      integer check (to_unit >= 0),
  topic        text,
  next_plan    text,
  created_at   timestamptz not null default now()
);

-- 기존 DB 업그레이드용: 예전 schema.sql 을 이미 실행했다면 아래 문장이 수업 진도 컬럼을 추가합니다.
-- (신규 설치에서는 이미 존재하므로 아무 일도 일어나지 않습니다.)
alter table public.lessons add column if not exists textbook_id uuid references public.textbooks(id) on delete set null;
alter table public.lessons add column if not exists from_unit integer check (from_unit >= 0);
alter table public.lessons add column if not exists to_unit integer check (to_unit >= 0);
alter table public.lessons add column if not exists topic text;
alter table public.lessons add column if not exists next_plan text;
alter table public.lessons add column if not exists homework_note text;   -- 숙제 내용(예: 단어 Day 5 쓰기)

-- 시험 / 단어 점수
create table if not exists public.tests (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  test_date   date not null default current_date,
  kind        text not null default '단어시험' check (kind in ('단어시험','단원평가','모의고사','기타')),
  title       text,
  score       numeric not null check (score >= 0),
  max_score   numeric not null default 100 check (max_score > 0),
  created_at  timestamptz not null default now()
);

-- AI 추천 이력: 다음 수업 진도 추천과 그 결과(채택 여부)를 기록
create table if not exists public.recommendations (
  id                 uuid primary key default gen_random_uuid(),
  owner              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id         uuid not null references public.students(id) on delete cascade,
  textbook_id        uuid references public.textbooks(id) on delete set null,
  target_date        date,                       -- 추천이 적용될 예정 수업일
  from_unit          integer not null check (from_unit >= 0),
  to_unit            integer not null,
  rationale          text,                       -- 추천 근거(에이전트가 남긴 설명)
  input_snapshot     jsonb,                      -- 추천 당시 입력(진도, 최근 점수, 출결 등)
  model              text,                       -- 추천을 만든 모델/에이전트 이름
  status             text not null default '제안' check (status in ('제안','채택','수정','거절')),
  applied_lesson_id  uuid references public.lessons(id) on delete set null,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,                -- 선생님이 채택/수정/거절한 시각
  check (to_unit >= from_unit)
);

-- 학부모 안내문 발송 기록 (중복·누락 방지용 표시. 실제 발송은 카카오톡/문자로 직접)
create table if not exists public.report_logs (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id    uuid not null references public.students(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  label         text,                       -- 주간 / 월간 / 기간
  sent_at       timestamptz not null default now(),
  check (period_end >= period_start)
);
create index if not exists idx_report_logs_student on public.report_logs(student_id, sent_at desc);

create index if not exists idx_progress_student on public.progress(student_id);
create index if not exists idx_lessons_student_date on public.lessons(student_id, lesson_date desc);
create index if not exists idx_lessons_textbook on public.lessons(textbook_id);
create index if not exists idx_tests_student_date on public.tests(student_id, test_date desc);
create index if not exists idx_recs_student_created on public.recommendations(student_id, created_at desc);

-- ============================================================
-- 2. RLS (행 수준 보안)
--    로그인한 본인(owner)의 데이터만 읽고 쓸 수 있습니다.
--    로그인하지 않은 사람(anon)은 아무것도 접근할 수 없습니다.
-- ============================================================

alter table public.students  enable row level security;
alter table public.textbooks enable row level security;
alter table public.progress  enable row level security;
alter table public.lessons   enable row level security;
alter table public.tests     enable row level security;
alter table public.recommendations enable row level security;
alter table public.report_logs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['students','textbooks','progress','lessons','tests','recommendations','report_logs'] loop
    execute format('drop policy if exists "owner_all" on public.%I', t);
    execute format(
      'create policy "owner_all" on public.%I for all to authenticated
         using (owner = (select auth.uid()))
         with check (owner = (select auth.uid()))', t);
  end loop;
end $$;

-- anon 역할의 직접 권한을 제거 (이중 안전장치)
revoke all on public.students, public.textbooks, public.progress, public.lessons, public.tests, public.recommendations, public.report_logs from anon;
