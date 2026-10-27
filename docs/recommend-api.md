# 진도 추천 API (Claude 예약 작업용)

흐름: **Claude 예약 작업** → `GET /api/progress` (현재 진도 읽기) → Claude가 학생별 추천 생성 → `POST /api/recommendations` (추천 쓰기) → DB의 `recommendations` 테이블에 **제안** 상태로 저장.
진도표(`progress`)는 이 API로 바뀌지 않습니다. 선생님이 확인한 뒤에만 반영합니다.

## 보안 구조
- 학생 이름은 내보내지 않고 가명(`S01`, `S02`…)과 학년만 줍니다. 수업 메모(`memo`)도 제외합니다.
- 접근 토큰은 **해시(sha256)만 DB에 저장**합니다. 코드·저장소에는 토큰이 없습니다.
- Worker에는 공개용(publishable) 키만 들어 있고, 비밀 키(service_role / secret)는 쓰지 않습니다.
- 토큰으로 할 수 있는 일은 읽기 함수와 쓰기 함수 두 가지뿐입니다. 쓰기는 단원 범위를 검증하고 '제안' 상태로만 저장합니다.
- 토큰은 `Authorization: Bearer <토큰>` 헤더로만 받습니다. 주소(쿼리)에 넣은 토큰은 인정하지 않습니다.

## 1. 설정 (한 번만)
1. Supabase SQL Editor 에서 최신 `schema.sql` 을 실행합니다. (`api_tokens` 테이블과 함수 2개가 추가됩니다)
2. 토큰을 만듭니다. 40자 이상의 무작위 문자열이면 됩니다. 예: 비밀번호 생성기, 또는 터미널에서 `openssl rand -hex 24`
3. SQL Editor 에서 아래를 실행합니다. `여기에_토큰` 부분만 바꾸세요. (이 토큰은 채팅에 붙여넣지 마세요)
   ```sql
   insert into public.api_tokens (owner, token_hash, label)
   select id, encode(extensions.digest(convert_to('여기에_토큰', 'UTF8'), 'sha256'), 'hex'), 'claude-schedule'
   from auth.users order by created_at limit 1;
   ```
4. 토큰을 폐기하려면: `update public.api_tokens set revoked_at = now() where label = 'claude-schedule';`

## 2. 연결 확인
배포 주소가 `https://rachel-english.ecarusblue.workers.dev` 라면:
```
curl https://rachel-english.ecarusblue.workers.dev/api/ping
# {"ok":true,"service":"rachel-english","time":"..."}
```
Claude 예약 작업이 실행되는 환경에서 이 주소가 막혀 있으면(403) 호출할 수 없습니다. 그 환경의 네트워크 허용 목록에 이 주소를 추가해야 합니다.

## 3. API
### GET /api/progress
```
curl -H "Authorization: Bearer $TOKEN" https://.../api/progress
```
응답(요약):
```json
{"ok": true, "data": {
  "today": "2026-10-15",
  "students": [{
    "alias": "S01", "grade": "초5", "lessons_per_week": 1.5,
    "class_weekdays": [1, 3],
    "books": [{"textbook_id": "…", "title": "Grammar Zone 1", "unit_label": "Unit", "structure": null,
               "weekdays": [1], "total_units": 20, "current_unit": 7, "remaining_units": 13, "lessons_done": 6, "basis": "lesson_avg", "avg_units_per_lesson": 2.0,
               "next_textbook": {"textbook_id": "…", "title": "Grammar Zone 2"}}],
    "recent_lessons": [{"date": "…", "attendance": "출석",
                        "textbook_id": "…", "from_unit": 6, "to_unit": 7, "topic": "…", "extra_books": null, "next_plan": "…"}],
    "recent_tests": [{"date": "…", "kind": "단어시험", "percent": 90}]
  }]}}
```
`next_textbook` 은 선생님이 정해 둔 "이 교재를 끝낸 뒤 이어서 할 교재"이며, 정하지 않았으면 `null` 입니다. 교재를 거의 끝냈다면 추천 근거에 참고하세요.
재원 중인 학생만 나옵니다. 가명은 등록 순서로 정해지며 학생이 삭제되지 않는 한 유지됩니다.

### POST /api/recommendations
```
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"Claude(예약 작업)","items":[{"alias":"S01","textbook_id":"…","from_unit":8,"to_unit":9,"target_date":"2026-10-20","rationale":"최근 시험 90점, 숙제 안정적이라 기준 속도 유지"}]}' \
  https://.../api/recommendations
```
응답: `{"ok":true,"data":{"inserted":1,"updated":0,"unchanged":0,"skipped":0,"errors":[]}}`
- `alias`, `textbook_id` 는 읽기 응답의 값을 그대로 씁니다. `target_date` 는 생략하면 오늘(한국 시간)입니다.
- **있으면 수정, 없으면 추가(upsert)**: 같은 학생·교재·수업일(`target_date`)을 기준으로 처리합니다.
  - 없음 → 새로 저장 (`inserted`)
  - '제안' 상태가 있고 내용이 다름 → 최신 내용으로 수정 (`updated`)
  - '제안' 상태가 있고 내용이 같음 → 그대로 둠 (`unchanged`)
  - 이미 채택·수정·거절로 처리된 기록이 있음 → 덮어쓰지 않고 건너뜀 (`skipped`)
- 교재에 수업 요일(`weekdays`)이 지정돼 있는데 `target_date` 의 요일이 거기에 없으면 그 항목은 `errors` 에 담깁니다(비어 있으면 모든 요일 가능).
- 같은 학생이 같은 날 교재 2개 이상을 추천받아도 됩니다(교재마다 항목 하나). 앱에서는 한 번에 수업 기록으로 채워집니다.
- 단원 범위가 1~전체 단원을 벗어나거나 배정되지 않은 교재면 그 항목만 `errors` 에 담기고 나머지는 저장됩니다.
- 한 번에 최대 100개, 본문 100KB 까지입니다.

오류: 401(토큰 없음/틀림), 400(형식 오류), 405(메서드 오류), 413(너무 큼), 502(DB 연결 문제).

## 4. 예약 작업 프롬프트 예시
```
아래 순서로 영어 공부방 학생별 다음 수업 진도를 추천하세요.
1. GET https://rachel-english.ecarusblue.workers.dev/api/progress 를 Authorization: Bearer <토큰> 헤더로 호출합니다. today 를 기준일로 쓰고 요일은 date 명령으로 계산합니다.
2. 학생별 수업일: class_weekdays(0=일…6=토)에 든 요일이 그 학생의 수업일입니다. 비어 있으면 월~목으로 봅니다. 기준일 이후 이번 주 남은 수업일을 대상으로 하고, 없으면 다음 주 수업일입니다.
   recent_lessons 에 같은 날짜 기록이 있는 날은 그 학생에게 추천하지 않습니다.
3. 수업일마다 그날 요일에 맞는 교재만 고릅니다: books[].weekdays 가 비어 있거나 그 요일을 포함하는 교재.
4. 교재별로, 그 교재가 나가는 수업일끼리만 이어서 단원 범위를 정합니다.
   - 한 수업 분량은 books[].basis 로 정합니다.
     · `lesson_avg` (이 교재로 수업한 기록이 있는 진행 중 교재): n = avg_units_per_lesson(최근 8회 평균)을 0.5 단위로 반올림한 값(최소 1). daily_min~daily_max 는 쓰지 않습니다.
     · `daily_range` (수업 기록이 아직 없는 새 교재): daily_min~daily_max 가 있으면 그 범위 안에서 정합니다(0.5 단위 값, 단위는 daily_unit: 'leaf'=소단원·단원, 'top'=1레벨). 범위도 없으면 n=2.
     첫 날은 current_unit+1 부터 n개, 다음 날은 직전 to_unit+1 부터.
     n 이 0.5 단위(예: 1.5)이면 수업마다 올림·내림을 번갈아 합니다(2개 → 1개 → 2개 …, 평균 1.5). n=0.5 이면 한 단원을 두 수업에 나눠 같은 단원을 두 번 추천하고(from_unit=to_unit), rationale 에 "앞부분" / "이어서 마무리"라고 적습니다.
   - 숙제는 추천에 반영하지 않습니다(API에도 포함되지 않습니다). 최근 시험 percent 가 70 미만이면 분량을 줄이고(최소 1) 첫 날 복습을 권합니다. 매우 좋으면 1단원 늘릴 수 있습니다.
   - from_unit 은 1 이상, to_unit 은 from_unit 이상이며 total_units 를 넘기지 않습니다. total_units 를 채우면 그 뒤 날짜는 추천하지 않습니다.
   - 번호는 누적 번호로 계산하고, rationale 에는 structure 가 있으면 이름("Unit 2 › Part B")으로 풀어 씁니다.
5. POST /api/recommendations 로 한 번에 보냅니다(최대 100개). 항목은 (학생, 교재, 수업일)마다 하나: alias, textbook_id, from_unit, to_unit, target_date, rationale(한국어 1~3문장, 요일 포함).
6. 응답의 inserted / updated / unchanged / skipped / errors 를 요약해서 보고합니다. 학생 실명은 알 수 없으며 추측하지 않습니다.
```

## 교재 구조(`structure`)
`books[].structure` 가 `null` 이면 `unit_label` 에 번호를 붙인 한 줄 단원입니다(Unit 1~N).
값이 있으면 `{"items":[{"name":"Unit 1"},{"name":"Unit 2","children":["Part A","Part B"]}]}` 형태이며,
**하위가 없는 항목과 하위 항목을 위에서부터 센 누적 번호**가 `current_unit`, `from_unit`, `to_unit` 입니다
(위 예: Unit 1=1, Unit 2›Part A=2, Unit 2›Part B=3). 추천(`from_unit`/`to_unit`)은 항상 이 누적 번호로 보내고,
`rationale` 에는 이름("Unit 2 › Part B")으로 풀어 쓰면 읽기 좋습니다.

## 한 수업에 교재가 여러 개일 때
`recent_lessons[]` 의 `textbook_id`·`from_unit`·`to_unit`·`topic` 은 **첫 번째 교재**이고, 두 번째 이후 교재는 `extra_books`
(`[{"textbook_id","from_unit","to_unit","topic"}]`, 없으면 `null`)에 들어 있습니다. 교재별 진도를 볼 때는 둘 다 확인하세요.

## 교재별 수업 요일
`books[].daily_min` / `daily_max` 는 선생님이 교재 배정 때 정한 **하루(한 번의 수업) 진도 범위**입니다(없으면 null). **새로 시작하는 교재(`basis`='daily_range')에만** 쓰고, 진행 중인 교재는 최근 수업 평균을 씁니다. (최신 `schema.sql` 을 다시 실행해야 컬럼이 생깁니다.)

`books[].weekdays` 는 그 교재를 쓰는 수업 요일 배열입니다(0=일 … 6=토, 예: `[1,3]` = 월·수). **빈 배열이면 모든 수업**에서 쓰는 교재입니다.
추천할 날짜의 요일에 맞는 교재만 추천하세요(서버도 요일이 맞지 않는 항목은 거절합니다). 학생의 수업 요일은 `class_weekdays`(시간표)입니다. (최신 `schema.sql` 을 다시 실행해야 `weekdays` 컬럼이 생깁니다.)

> 선생님이 앱에서 '추천 수정'으로 직접 고친 추천(`edited_at` 있음)은 같은 학생·교재·수업일로 다시 제출해도 덮어쓰지 않고 건너뜁니다.
