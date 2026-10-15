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
    "books": [{"textbook_id": "…", "title": "Grammar Zone 1", "unit_label": "Unit",
               "total_units": 20, "current_unit": 7, "remaining_units": 13, "avg_units_per_lesson": 2.0}],
    "recent_lessons": [{"date": "…", "attendance": "출석", "homework": "완료", "homework_note": "…",
                        "textbook_id": "…", "from_unit": 6, "to_unit": 7, "topic": "…", "next_plan": "…"}],
    "recent_tests": [{"date": "…", "kind": "단어시험", "percent": 90}]
  }]}}
```
재원 중인 학생만 나옵니다. 가명은 등록 순서로 정해지며 학생이 삭제되지 않는 한 유지됩니다.

### POST /api/recommendations
```
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"Claude(예약 작업)","items":[{"alias":"S01","textbook_id":"…","from_unit":8,"to_unit":9,"target_date":"2026-10-20","rationale":"최근 시험 90점, 숙제 안정적이라 기준 속도 유지"}]}' \
  https://.../api/recommendations
```
응답: `{"ok":true,"data":{"inserted":1,"skipped":0,"errors":[]}}`
- `alias`, `textbook_id` 는 읽기 응답의 값을 그대로 씁니다. `target_date` 는 생략하면 오늘(한국 시간)입니다.
- 같은 학생·교재·수업일에 이미 '제안' 상태가 있으면 `skipped` 로 건너뜁니다.
- 단원 범위가 1~전체 단원을 벗어나거나 배정되지 않은 교재면 그 항목만 `errors` 에 담기고 나머지는 저장됩니다.
- 한 번에 최대 100개, 본문 100KB 까지입니다.

오류: 401(토큰 없음/틀림), 400(형식 오류), 405(메서드 오류), 413(너무 큼), 502(DB 연결 문제).

## 4. 예약 작업 프롬프트 예시
```
아래 순서로 영어 공부방 학생별 다음 수업 진도를 추천하세요.
1. GET https://rachel-english.ecarusblue.workers.dev/api/progress 를 Authorization: Bearer <토큰> 헤더로 호출합니다.
2. students 의 각 교재(books)마다 다음 수업의 단원 범위를 정합니다.
   - 기준: avg_units_per_lesson(없으면 2)을 반올림한 개수만큼 current_unit+1 부터.
   - 최근 시험 percent 가 70 미만이거나 숙제가 '일부'/'미제출'이 반복되면 범위를 줄이고 복습을 권합니다.
   - 안정적이면 기준을 유지하고, 매우 좋으면 1단원 늘릴 수 있습니다.
   - from_unit 은 1 이상, to_unit 은 from_unit 이상이며 total_units 를 넘기지 않습니다.
3. 결과를 POST /api/recommendations 로 보냅니다. items 의 각 항목은 alias, textbook_id, from_unit, to_unit, target_date(다음 수업 예정일을 알면), rationale(한국어 1~3문장).
4. 응답의 inserted / skipped / errors 를 요약해서 보고합니다. 학생 실명은 알 수 없으며 추측하지 않습니다.
```
