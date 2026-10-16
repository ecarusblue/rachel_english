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
alter table public.lessons add column if not exists teacher_comment text check (char_length(teacher_comment) <= 5000);   -- 선생님 코멘트(긴 글)

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
        'books', coalesce((
          select jsonb_agg(jsonb_build_object(
            'textbook_id', t.id,
            'title', t.title,
            'unit_label', t.unit_label,
            'total_units', t.total_units,
            'current_unit', p.current_unit,
            'remaining_units', greatest(t.total_units - p.current_unit, 0),
            'avg_units_per_lesson', (
              select round(avg(x.n)::numeric, 1) from (
                select (l.to_unit - l.from_unit + 1) as n from public.lessons l
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
                   'topic', l.topic, 'next_plan', l.next_plan) as r
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

      -- 같은 학생·교재·수업일: 이미 처리된(채택/수정/거절) 기록이 있으면 건너뜀, '제안'이면 최신 내용으로 갱신, 없으면 추가
      if exists (select 1 from public.recommendations r
                  where r.student_id = v_student and r.textbook_id = v_book.id
                    and r.target_date = v_target and r.status <> '제안') then
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
