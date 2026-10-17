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

-- 교재 구조(선택): {"items":[{"name":"Unit 1"},{"name":"Unit 2","children":["Part A","Part B"]}]}
-- 비어 있으면 예전처럼 Unit 1~N 한 줄 번호. 진도 번호는 항상 맨 끝 항목을 위에서부터 센 누적 번호입니다.
alter table public.textbooks add column if not exists structure jsonb
  check (structure is null or jsonb_typeof(structure) = 'object');

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
-- 교재를 쓰는 수업 요일 (0=일 … 6=토). 빈 배열이면 모든 수업에서 쓰는 교재
alter table public.progress add column if not exists weekdays smallint[] not null default '{}';
-- 이 교재를 끝낸 뒤 이어서 할 교재 (표시·추천 참고용)
alter table public.progress add column if not exists next_textbook_id uuid references public.textbooks(id) on delete set null;

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
-- 한 번의 수업에서 교재를 여러 개 나갔을 때: 첫 교재는 위 컬럼에, 둘째부터는 이 JSON 배열에 저장
-- 예: [{"textbook_id":"…","from_unit":7,"to_unit":8,"topic":"단어 암기"}]
alter table public.lessons add column if not exists extra_books jsonb not null default '[]'::jsonb
  check (jsonb_typeof(extra_books) = 'array');

-- 교재별 수업 한 줄 보기 (첫 교재 + 추가 교재). RLS 는 조회하는 사용자의 권한으로 적용됩니다.
create or replace view public.lesson_book_rows with (security_invoker = true) as
  select l.id as lesson_id, l.owner, l.student_id, l.lesson_date, l.attendance, l.created_at,
         l.textbook_id, l.from_unit, l.to_unit, l.topic
    from public.lessons l where l.textbook_id is not null
  union all
  select l.id, l.owner, l.student_id, l.lesson_date, l.attendance, l.created_at,
         nullif(e->>'textbook_id', '')::uuid, nullif(e->>'from_unit', '')::integer, nullif(e->>'to_unit', '')::integer, e->>'topic'
    from public.lessons l cross join lateral jsonb_array_elements(l.extra_books) e
   where nullif(e->>'textbook_id', '') is not null;
alter table public.lessons add column if not exists next_plan text;
alter table public.lessons add column if not exists homework_note text;   -- 숙제 내용(예: 단어 Day 5 쓰기)
alter table public.lessons add column if not exists teacher_comment text check (char_length(teacher_comment) <= 5000);   -- 선생님 코멘트(긴 글)

-- 월말평가서 (학생·연·월별 1건)
create table if not exists public.monthly_evaluations (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id   uuid not null references public.students(id) on delete cascade,
  year         integer not null check (year between 2000 and 2100),
  month        integer not null check (month between 1 and 12),
  ratings      jsonb not null default '{}'::jsonb,   -- 영역별 평가 {listening:5,...} (1~5)
  attitude     jsonb not null default '{}'::jsonb,   -- 학습 태도 {participation:4,...} (1~5)
  achievement  text check (char_length(achievement) <= 3000),
  improvement  text check (char_length(improvement) <= 3000),
  next_plan    text check (char_length(next_plan) <= 3000),
  parent_note  text check (char_length(parent_note) <= 3000),
  status       text not null default '작성중' check (status in ('작성중','AI 초안','완료')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (student_id, year, month)
);

-- Claude 예약 작업이 쓴 초안 표시(AI 초안). 선생님이 앱에서 저장하면 'teacher' 로 바뀝니다.
alter table public.monthly_evaluations add column if not exists source   text not null default 'teacher' check (source in ('teacher','ai'));
alter table public.monthly_evaluations add column if not exists ai_model text;
-- 기존 DB 업그레이드: 상태에 'AI 초안' 추가(이미 있으면 같은 정의로 다시 만들 뿐), 예전 방식으로 저장된 AI 초안도 새 상태로 맞춤
alter table public.monthly_evaluations drop constraint if exists monthly_evaluations_status_check;
alter table public.monthly_evaluations add constraint monthly_evaluations_status_check check (status in ('작성중','AI 초안','완료'));
update public.monthly_evaluations set status = 'AI 초안' where source = 'ai' and status = '작성중';

-- 수업 시간표 (요일·타임·시간과 배정 학생을 매주 반복으로 저장)
create table if not exists public.schedule_slots (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  weekday      smallint not null check (weekday between 0 and 6),   -- 0=일 … 6=토
  slot_order   smallint not null default 0,
  label        text not null default '' check (char_length(label) <= 30),
  start_time   time,
  end_time     time,
  student_ids  uuid[] not null default '{}',
  created_at   timestamptz not null default now()
);
create index if not exists schedule_slots_weekday_idx on public.schedule_slots (weekday, slot_order);

-- 시험 / 단어 점수
create table if not exists public.tests (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  test_date   date not null default current_date,
  kind        text not null default '단어시험',
  title       text,
  score       numeric not null check (score >= 0),
  max_score   numeric not null default 100 check (max_score > 0),
  created_at  timestamptz not null default now()
);

-- 시험 종류 (기본 4종은 앱에 내장, 여기에는 선생님이 만든 종류만 저장)
create table if not exists public.test_kinds (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 30),
  default_max numeric not null default 100 check (default_max > 0),
  unit        text not null default '점',
  color       text,
  memo        text,
  created_at  timestamptz not null default now(),
  unique (owner, name)
);
alter table public.test_kinds add column if not exists unit text not null default '점';
alter table public.test_kinds enable row level security;
drop policy if exists "owner_all" on public.test_kinds;
create policy "owner_all" on public.test_kinds for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
revoke all on public.test_kinds from anon;
-- 예전 DB: tests.kind 의 고정 목록 제약 제거
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.tests'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%' loop
    execute format('alter table public.tests drop constraint %I', c);
  end loop;
end $$;

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
  edited_at          timestamptz,                -- 선생님이 '제안' 내용을 직접 고친 시각 (예약 작업이 덮어쓰지 않음)
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
alter table public.recommendations add column if not exists edited_at timestamptz;
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
alter table public.monthly_evaluations enable row level security;
alter table public.schedule_slots enable row level security;

do $$
declare t text;
begin
  foreach t in array array['students','textbooks','progress','lessons','tests','recommendations','report_logs','monthly_evaluations','schedule_slots'] loop
    execute format('drop policy if exists "owner_all" on public.%I', t);
    execute format(
      'create policy "owner_all" on public.%I for all to authenticated
         using (owner = (select auth.uid()))
         with check (owner = (select auth.uid()))', t);
  end loop;
end $$;

-- anon 역할의 직접 권한을 제거 (이중 안전장치)
revoke all on public.students, public.textbooks, public.progress, public.lessons, public.tests, public.recommendations, public.report_logs, public.monthly_evaluations, public.schedule_slots from anon;

-- ============================================================
-- 3. 추천용 API (Claude 예약 작업 전용)
--    - 읽기: api_read_progress(토큰)  -> 학생 이름 없이 가명(S01…)으로 현재 진도를 돌려줌
--    - 쓰기: api_submit_recommendations(토큰, 항목들) -> recommendations 에 '제안' 상태로만 저장
--    토큰은 해시(sha256)만 DB 에 저장합니다. 이 함수들 외에는 토큰으로 할 수 있는 일이 없습니다.
--    (사용법: docs/recommend-api.md)
-- ============================================================

create table if not exists public.api_tokens (
  id            uuid primary key default gen_random_uuid(),
  owner         uuid not null references auth.users(id) on delete cascade,
  token_hash    text not null unique,
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
alter table public.api_tokens enable row level security;   -- 정책 없음 = 앱에서는 접근 불가
revoke all on public.api_tokens from anon, authenticated;

create or replace function public.api_read_progress(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_hash  text := encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
  v_out   jsonb;
begin
  select t.owner into v_owner from public.api_tokens t where t.token_hash = v_hash and t.revoked_at is null;
  if v_owner is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  update public.api_tokens set last_used_at = now() where token_hash = v_hash;

  with st as (
    select s.id, s.grade, s.active,
           'S' || lpad((row_number() over (order by s.created_at, s.id))::text, 2, '0') as alias
      from public.students s
     where s.owner = v_owner
  )
  select jsonb_build_object(
    'generated_at', now(),
    'today', (now() at time zone 'Asia/Seoul')::date,
    'students', coalesce(jsonb_agg(
      jsonb_build_object(
        'alias', st.alias,
        'grade', st.grade,
        'lessons_per_week', (
          select round(count(*)::numeric / 4.0, 1) from public.lessons l
           where l.student_id = st.id and l.attendance <> '결석'
             and l.lesson_date >= (now() at time zone 'Asia/Seoul')::date - 28),
        'class_weekdays', coalesce((
          select jsonb_agg(distinct sl.weekday order by sl.weekday) from public.schedule_slots sl
           where sl.owner = v_owner and st.id = any(sl.student_ids)), '[]'::jsonb),
        'books', coalesce((
          select jsonb_agg(jsonb_build_object(
            'textbook_id', t.id,
            'title', t.title,
            'unit_label', t.unit_label,
            'structure', t.structure,
            'total_units', t.total_units,
            'weekdays', p.weekdays,
            'current_unit', p.current_unit,
            'remaining_units', greatest(t.total_units - p.current_unit, 0),
            'next_textbook', (select jsonb_build_object('textbook_id', nt.id, 'title', nt.title)
                                from public.textbooks nt where nt.id = p.next_textbook_id),
            'avg_units_per_lesson', (
              select round(avg(x.n)::numeric, 1) from (
                select (l.to_unit - l.from_unit + 1) as n from public.lesson_book_rows l
                 where l.student_id = st.id and l.textbook_id = t.id and l.attendance <> '결석'
                   and l.from_unit is not null and l.to_unit is not null
                 order by l.lesson_date desc, l.created_at desc limit 8) x)
          ) order by t.title)
          from public.progress p join public.textbooks t on t.id = p.textbook_id
         where p.student_id = st.id and p.owner = v_owner), '[]'::jsonb),
        'recent_lessons', coalesce((
          select jsonb_agg(r order by r->>'date' desc) from (
            select jsonb_build_object('date', l.lesson_date, 'attendance', l.attendance,
                   'homework', l.homework, 'homework_note', l.homework_note,
                   'textbook_id', l.textbook_id, 'from_unit', l.from_unit, 'to_unit', l.to_unit,
                   'topic', l.topic, 'extra_books', l.extra_books, 'next_plan', l.next_plan) as r
              from public.lessons l where l.student_id = st.id
             order by l.lesson_date desc, l.created_at desc limit 10) q), '[]'::jsonb),
        'recent_tests', coalesce((
          select jsonb_agg(r order by r->>'date' desc) from (
            select jsonb_build_object('date', t.test_date, 'kind', t.kind,
                   'percent', round((t.score / nullif(t.max_score, 0) * 100)::numeric, 0)) as r
              from public.tests t where t.student_id = st.id
             order by t.test_date desc, t.created_at desc limit 10) q), '[]'::jsonb)
      ) order by st.alias) filter (where st.active), '[]'::jsonb)
  ) into v_out
  from st;

  return v_out;
end;
$$;

create or replace function public.api_submit_recommendations(p_token text, p_items jsonb, p_model text default 'Claude(예약 작업)')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid;
  v_hash     text := encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
  v_item     jsonb;
  v_student  uuid;
  v_book     public.textbooks%rowtype;
  v_from     integer;
  v_to       integer;
  v_target   date;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_unchanged integer := 0;
  v_skipped  integer := 0;
  v_existing uuid;
  v_same     boolean;
  v_errors   jsonb := '[]'::jsonb;
begin
  select t.owner into v_owner from public.api_tokens t where t.token_hash = v_hash and t.revoked_at is null;
  if v_owner is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  update public.api_tokens set last_used_at = now() where token_hash = v_hash;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'too many items (max 100)';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      select q.id into v_student from (
        select s.id, s.active,
               'S' || lpad((row_number() over (order by s.created_at, s.id))::text, 2, '0') as alias
          from public.students s where s.owner = v_owner) q
       where q.alias = v_item->>'alias' and q.active;
      if v_student is null then raise exception 'unknown student alias'; end if;

      select t.* into v_book
        from public.textbooks t
        join public.progress p on p.textbook_id = t.id and p.student_id = v_student
       where t.id = (v_item->>'textbook_id')::uuid and t.owner = v_owner;
      if not found then raise exception 'textbook is not assigned to the student'; end if;

      v_from := (v_item->>'from_unit')::integer;
      v_to   := (v_item->>'to_unit')::integer;
      if v_from is null or v_to is null or v_from < 1 or v_to < v_from or v_to > v_book.total_units then
        raise exception 'invalid unit range (1..%)', v_book.total_units;
      end if;
      v_target := coalesce((v_item->>'target_date')::date, (now() at time zone 'Asia/Seoul')::date);
      -- 교재에 수업 요일이 지정돼 있으면 그 요일의 수업일에만 추천할 수 있음 (비어 있으면 모든 수업)
      if exists (select 1 from public.progress p
                  where p.student_id = v_student and p.textbook_id = v_book.id
                    and cardinality(p.weekdays) > 0
                    and not (extract(dow from v_target)::smallint = any(p.weekdays))) then
        raise exception 'target_date weekday is not one of the textbook weekdays';
      end if;

      -- 같은 학생·교재·수업일: 이미 처리된(채택/수정/거절) 기록이 있으면 건너뜀, '제안'이면 최신 내용으로 갱신, 없으면 추가
      if exists (select 1 from public.recommendations r
                  where r.student_id = v_student and r.textbook_id = v_book.id
                    and r.target_date = v_target and (r.status <> '제안' or r.edited_at is not null)) then
        v_skipped := v_skipped + 1;
      else
        select r.id, (r.from_unit = v_from and r.to_unit = v_to
                      and r.rationale is not distinct from left(nullif(trim(coalesce(v_item->>'rationale', '')), ''), 600))
          into v_existing, v_same
          from public.recommendations r
         where r.student_id = v_student and r.textbook_id = v_book.id
           and r.target_date = v_target and r.status = '제안'
         order by r.created_at desc limit 1;

        if v_existing is null then
          insert into public.recommendations (owner, student_id, textbook_id, target_date, from_unit, to_unit, rationale, model, status)
          values (v_owner, v_student, v_book.id, v_target, v_from, v_to,
                  left(nullif(trim(coalesce(v_item->>'rationale', '')), ''), 600),
                  left(coalesce(p_model, 'Claude'), 100), '제안');
          v_inserted := v_inserted + 1;
        elsif v_same then
          v_unchanged := v_unchanged + 1;
        else
          update public.recommendations
             set from_unit = v_from, to_unit = v_to,
                 rationale = left(nullif(trim(coalesce(v_item->>'rationale', '')), ''), 600),
                 model = left(coalesce(p_model, 'Claude'), 100),
                 created_at = now()
           where id = v_existing and status = '제안';
          v_updated := v_updated + 1;
        end if;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('alias', v_item->>'alias', 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'unchanged', v_unchanged, 'skipped', v_skipped, 'errors', v_errors);
end;
$$;

revoke all on function public.api_read_progress(text) from public;
revoke all on function public.api_submit_recommendations(text, jsonb, text) from public;
grant execute on function public.api_read_progress(text) to anon, authenticated;
grant execute on function public.api_submit_recommendations(text, jsonb, text) to anon, authenticated;

-- ============================================================
-- 4. 월말평가서용 API (Claude 예약 작업 전용)
--    - 읽기: api_read_evaluation_source(토큰, 연, 월) -> 학생 이름 없이 가명으로 그 달의 수업·시험 자료를 돌려줌
--    - 쓰기: api_submit_evaluations(토큰, 항목들)     -> monthly_evaluations 에 상태 'AI 초안'으로만 저장
--    규칙: 평가서가 없으면 추가, 상태가 'AI 초안'이면 수정, 그 외 상태(작성 중·완료)면 건너뜀. (사용법: docs/evaluation-api.md)
-- ============================================================

-- 학생 실명(전체 이름·이름 부분)을 가명으로 바꿉니다. 선생님 코멘트를 내보내기 전에 사용합니다.
create or replace function public._api_mask_names(p_owner uuid, p_text text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v text := p_text;
begin
  if v is null then return null; end if;
  for r in
    select q.name, q.alias from (
      select s.name,
             'S' || lpad((row_number() over (order by s.created_at, s.id))::text, 2, '0') as alias
        from public.students s where s.owner = p_owner) q
     order by char_length(q.name) desc
  loop
    if char_length(r.name) >= 2 then v := replace(v, r.name, r.alias); end if;
    if char_length(r.name) >= 3 then v := replace(v, substr(r.name, 2), r.alias); end if;
  end loop;
  return v;
end;
$$;
revoke all on function public._api_mask_names(uuid, text) from public, anon, authenticated;

create or replace function public.api_read_evaluation_source(p_token text, p_year integer default null, p_month integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_hash  text := encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_year  integer := coalesce(p_year, extract(year from (now() at time zone 'Asia/Seoul'))::integer);
  v_month integer := coalesce(p_month, extract(month from (now() at time zone 'Asia/Seoul'))::integer);
  v_start date;
  v_end   date;
  v_out   jsonb;
begin
  select t.owner into v_owner from public.api_tokens t where t.token_hash = v_hash and t.revoked_at is null;
  if v_owner is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  update public.api_tokens set last_used_at = now() where token_hash = v_hash;

  if v_year < 2000 or v_year > 2100 or v_month < 1 or v_month > 12 then
    raise exception 'invalid year/month';
  end if;
  v_start := make_date(v_year, v_month, 1);
  v_end   := (v_start + interval '1 month' - interval '1 day')::date;

  with st as (
    select s.id, s.grade, s.active,
           'S' || lpad((row_number() over (order by s.created_at, s.id))::text, 2, '0') as alias
      from public.students s
     where s.owner = v_owner
  )
  select jsonb_build_object(
    'generated_at', now(),
    'today', v_today,
    'year', v_year,
    'month', v_month,
    'period', jsonb_build_object('start', v_start, 'end', v_end),
    'form', jsonb_build_object(
      'scale', '1~5 (5가 가장 좋음)',
      'skills', jsonb_build_array('listening', 'speaking', 'reading', 'writing', 'vocab', 'grammar'),
      'attitude', jsonb_build_array('participation', 'focus', 'homework'),
      'texts', jsonb_build_array('achievement', 'improvement', 'next_plan', 'parent_note'),
      'text_max_chars', 3000),
    'students', coalesce(jsonb_agg(
      jsonb_build_object(
        'alias', st.alias,
        'grade', st.grade,
        'existing', (
          select jsonb_build_object('status', e.status, 'source', e.source)
            from public.monthly_evaluations e
           where e.student_id = st.id and e.year = v_year and e.month = v_month),
        'attendance', (
          select jsonb_build_object(
            '출석', count(*) filter (where l.attendance = '출석'),
            '지각', count(*) filter (where l.attendance = '지각'),
            '결석', count(*) filter (where l.attendance = '결석'),
            '보강', count(*) filter (where l.attendance = '보강'))
            from public.lessons l
           where l.student_id = st.id and l.lesson_date between v_start and v_end),
        'homework', (
          select jsonb_build_object(
            '완료', count(*) filter (where l.homework = '완료'),
            '일부', count(*) filter (where l.homework = '일부'),
            '미제출', count(*) filter (where l.homework = '미제출'))
            from public.lessons l
           where l.student_id = st.id and l.lesson_date between v_start and v_end and l.attendance <> '결석'),
        'books', coalesce((
          select jsonb_agg(jsonb_build_object(
            'title', t.title,
            'unit_label', t.unit_label,
            'structure', t.structure,
            'total_units', t.total_units,
            'weekdays', p.weekdays,
            'current_unit', p.current_unit,
            'month_from_unit', (select min(l.from_unit) from public.lesson_book_rows l
                                 where l.student_id = st.id and l.textbook_id = t.id and l.attendance <> '결석'
                                   and l.lesson_date between v_start and v_end),
            'month_to_unit', (select max(l.to_unit) from public.lesson_book_rows l
                               where l.student_id = st.id and l.textbook_id = t.id and l.attendance <> '결석'
                                 and l.lesson_date between v_start and v_end),
            'month_lessons', (select count(*) from public.lesson_book_rows l
                               where l.student_id = st.id and l.textbook_id = t.id and l.attendance <> '결석'
                                 and l.lesson_date between v_start and v_end)
          ) order by t.title)
          from public.progress p join public.textbooks t on t.id = p.textbook_id
         where p.student_id = st.id and p.owner = v_owner), '[]'::jsonb),
        'lessons', coalesce((
          select jsonb_agg(x.r order by x.d) from (
            select l.lesson_date as d,
                   jsonb_build_object('date', l.lesson_date, 'attendance', l.attendance,
                     'homework', l.homework,
                     'homework_note', public._api_mask_names(v_owner, left(l.homework_note, 300)),
                     'topic', public._api_mask_names(v_owner, left(l.topic, 300)),
                     'extra_books', coalesce((select jsonb_agg(jsonb_build_object(
                         'textbook_id', e->>'textbook_id', 'from_unit', e->'from_unit', 'to_unit', e->'to_unit',
                         'topic', public._api_mask_names(v_owner, left(e->>'topic', 300))))
                       from jsonb_array_elements(l.extra_books) e), '[]'::jsonb),
                     'next_plan', public._api_mask_names(v_owner, left(l.next_plan, 300)),
                     'teacher_comment', public._api_mask_names(v_owner, left(l.teacher_comment, 1500))) as r
              from public.lessons l
             where l.student_id = st.id and l.lesson_date between v_start and v_end
             order by l.lesson_date limit 40) x), '[]'::jsonb),
        'tests', coalesce((
          select jsonb_agg(x.r order by x.d) from (
            select t.test_date as d,
                   jsonb_build_object('date', t.test_date, 'kind', t.kind,
                     'percent', round((t.score / nullif(t.max_score, 0) * 100)::numeric, 0)) as r
              from public.tests t
             where t.student_id = st.id and t.test_date between v_start and v_end
             order by t.test_date limit 40) x), '[]'::jsonb),
        'test_trend', coalesce((
          select jsonb_agg(jsonb_build_object('month', y.m, 'kind', y.kind, 'avg_percent', y.a, 'count', y.n) order by y.m, y.kind)
            from (
              select to_char(t.test_date, 'YYYY-MM') as m, t.kind,
                     round(avg(t.score / nullif(t.max_score, 0) * 100)::numeric, 0) as a, count(*) as n
                from public.tests t
               where t.student_id = st.id
                 and t.test_date >= (v_start - interval '3 months')::date and t.test_date <= v_end
               group by 1, 2) y), '[]'::jsonb)
      ) order by st.alias) filter (where st.active), '[]'::jsonb)
  ) into v_out
  from st;

  return v_out;
end;
$$;

create or replace function public.api_submit_evaluations(p_token text, p_items jsonb, p_model text default 'Claude(예약 작업)')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner    uuid;
  v_hash     text := encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
  v_item     jsonb;
  v_student  uuid;
  v_year     integer;
  v_month    integer;
  v_ratings  jsonb;
  v_attitude jsonb;
  v_ach      text;
  v_imp      text;
  v_next     text;
  v_note     text;
  v_ex       public.monthly_evaluations%rowtype;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_skipped  integer := 0;
  v_errors   jsonb := '[]'::jsonb;
  k          text;
  val        jsonb;

begin
  select t.owner into v_owner from public.api_tokens t where t.token_hash = v_hash and t.revoked_at is null;
  if v_owner is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  update public.api_tokens set last_used_at = now() where token_hash = v_hash;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items must be a JSON array';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'too many items (max 100)';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    begin
      v_student := null;
      select q.id into v_student from (
        select s.id, s.active,
               'S' || lpad((row_number() over (order by s.created_at, s.id))::text, 2, '0') as alias
          from public.students s where s.owner = v_owner) q
       where q.alias = v_item->>'alias' and q.active;
      if v_student is null then raise exception 'unknown student alias'; end if;

      v_year  := (v_item->>'year')::integer;
      v_month := (v_item->>'month')::integer;
      if v_year is null or v_month is null or v_year < 2000 or v_year > 2100 or v_month < 1 or v_month > 12 then
        raise exception 'invalid year/month';
      end if;

      -- 평가 점수: 허용된 항목만, 1~5 정수만
      -- 보내지 않은 항목은 기본값 3(보통)
      v_ratings := '{"listening":3,"speaking":3,"reading":3,"writing":3,"vocab":3,"grammar":3}'::jsonb;
      if v_item ? 'ratings' and jsonb_typeof(v_item->'ratings') = 'object' then
        for k, val in select * from jsonb_each(v_item->'ratings') loop
          if k not in ('listening','speaking','reading','writing','vocab','grammar') then raise exception 'unknown rating key: %', k; end if;
          if jsonb_typeof(val) <> 'number' or (val::text)::numeric <> trunc((val::text)::numeric) or (val::text)::numeric not between 1 and 5 then
            raise exception 'rating % must be an integer 1..5', k;
          end if;
          v_ratings := v_ratings || jsonb_build_object(k, (val::text)::integer);
        end loop;
      end if;
      v_attitude := '{"participation":3,"focus":3,"homework":3}'::jsonb;
      if v_item ? 'attitude' and jsonb_typeof(v_item->'attitude') = 'object' then
        for k, val in select * from jsonb_each(v_item->'attitude') loop
          if k not in ('participation','focus','homework') then raise exception 'unknown attitude key: %', k; end if;
          if jsonb_typeof(val) <> 'number' or (val::text)::numeric <> trunc((val::text)::numeric) or (val::text)::numeric not between 1 and 5 then
            raise exception 'attitude % must be an integer 1..5', k;
          end if;
          v_attitude := v_attitude || jsonb_build_object(k, (val::text)::integer);
        end loop;
      end if;

      v_ach  := left(nullif(trim(coalesce(v_item->>'achievement', '')), ''), 3000);
      v_imp  := left(nullif(trim(coalesce(v_item->>'improvement', '')), ''), 3000);
      v_next := left(nullif(trim(coalesce(v_item->>'next_plan', '')), ''), 3000);
      v_note := left(nullif(trim(coalesce(v_item->>'parent_note', '')), ''), 3000);

      select e.* into v_ex from public.monthly_evaluations e
       where e.student_id = v_student and e.year = v_year and e.month = v_month;

      if not found then
        insert into public.monthly_evaluations (owner, student_id, year, month, ratings, attitude, achievement, improvement, next_plan, parent_note, status, source, ai_model)
        values (v_owner, v_student, v_year, v_month, v_ratings, v_attitude, v_ach, v_imp, v_next, v_note, 'AI 초안', 'ai', left(coalesce(p_model, 'Claude'), 100));
        v_inserted := v_inserted + 1;
      elsif v_ex.status = 'AI 초안' then
        update public.monthly_evaluations
           set ratings = v_ratings, attitude = v_attitude, achievement = v_ach, improvement = v_imp,
               next_plan = v_next, parent_note = v_note, source = 'ai', ai_model = left(coalesce(p_model, 'Claude'), 100), updated_at = now()
         where id = v_ex.id and status = 'AI 초안';
        v_updated := v_updated + 1;
      else
        v_skipped := v_skipped + 1;   -- 상태가 'AI 초안'이 아닌(작성 중·완료) 평가서는 건드리지 않음
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('alias', v_item->>'alias', 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped, 'errors', v_errors);
end;
$$;

revoke all on function public.api_read_evaluation_source(text, integer, integer) from public;
revoke all on function public.api_submit_evaluations(text, jsonb, text) from public;
grant execute on function public.api_read_evaluation_source(text, integer, integer) to anon, authenticated;
grant execute on function public.api_submit_evaluations(text, jsonb, text) to anon, authenticated;
