# 월말평가서 API (Claude 예약 작업용)

흐름: **Claude 예약 작업** → `GET /api/evaluation-source` (그 달의 수업·시험 자료 읽기) → Claude가 학생별 평가서 초안 작성 → `POST /api/evaluations` (초안 쓰기) → 앱의 **월말평가서** 목록에 **AI 초안**(작성 중)으로 나타남 → 선생님이 확인·수정 후 저장 → '완료'로 확정.

설정(토큰, 연결 확인, 보안 구조)은 [수업 추천 API](recommend-api.md)와 **같은 토큰**을 씁니다. 처음 한 번 최신 `schema.sql` 을 Supabase SQL Editor 에서 다시 실행하세요. (평가서 `source`·`ai_model` 컬럼과 함수 3개가 추가됩니다.)

## 보안·안전 장치
- 학생 실명은 내보내지 않고 가명(`S01`, `S02`…)만 줍니다. 수업 메모(`memo`)는 제외합니다.
- 선생님 코멘트(`teacher_comment`)와 숙제·주제 메모는 **내용 안의 학생 이름(전체 이름·이름 부분)을 가명으로 바꿔서** 내보냅니다. (예: "하준이는 발표를 잘함" → "S01이는 발표를 잘함")
- 쓰기는 **항상 '작성 중 · AI 초안'** 으로만 저장됩니다. '완료' 처리는 선생님만 할 수 있습니다.
- **덮어쓰기 보호**: 선생님이 쓰거나 고친 평가서, '완료'된 평가서는 건드리지 않고 건너뜁니다. 아직 손대지 않은 AI 초안만 최신 내용으로 다시 씁니다.
- 읽기·쓰기 함수 외에 토큰으로 할 수 있는 일은 없습니다.

## GET /api/evaluation-source
```
curl -H "Authorization: Bearer $TOKEN" "https://rachel-english.ecarusblue.workers.dev/api/evaluation-source?year=2026&month=10"
```
`year`, `month` 를 생략하면 한국 시간 기준 이번 달입니다. 재원 중인 학생만 나옵니다.

응답(요약):
```json
{"ok": true, "data": {
  "year": 2026, "month": 10, "period": {"start": "2026-10-01", "end": "2026-10-31"},
  "form": {"scale": "1~5 (5가 가장 좋음)",
           "skills": ["listening","speaking","reading","writing","vocab","grammar"],
           "attitude": ["participation","focus","homework"],
           "texts": ["achievement","improvement","next_plan","parent_note"], "text_max_chars": 3000},
  "students": [{
    "alias": "S01", "grade": "초5",
    "existing": null,
    "attendance": {"출석": 7, "지각": 1, "결석": 0, "보강": 0},
    "homework": {"완료": 6, "일부": 2, "미제출": 0},
    "books": [{"title": "Grammar Zone 1", "unit_label": "Unit", "total_units": 20, "current_unit": 9,
               "month_from_unit": 5, "month_to_unit": 9, "month_lessons": 4}],
    "lessons": [{"date": "2026-10-05", "attendance": "출석", "homework": "완료", "homework_note": "…",
                 "topic": "present perfect", "next_plan": "…", "teacher_comment": "…"}],
    "tests": [{"date": "2026-10-08", "kind": "단어시험", "percent": 90}],
    "test_trend": [{"month": "2026-09", "kind": "단어시험", "avg_percent": 70, "count": 2}]
  }]}}
```
- `existing` 이 `null` 이 아니면 이미 평가서가 있다는 뜻입니다. `{"status":"완료"}` 이거나 `{"source":"teacher"}` 이면 쓰기 요청이 건너뛰어집니다.
- `test_trend` 는 해당 월 포함 직전 3개월의 종류별 월 평균입니다.

## POST /api/evaluations
```
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"Claude(예약 작업)","items":[{"alias":"S01","year":2026,"month":10,
        "ratings":{"vocab":4},"attitude":{"homework":4,"participation":5},
        "achievement":"…","improvement":"…","next_plan":"…","parent_note":"…"}]}' \
  https://rachel-english.ecarusblue.workers.dev/api/evaluations
```
응답: `{"ok":true,"data":{"inserted":1,"updated":0,"skipped":0,"errors":[]}}`
- `ratings` 는 `listening, speaking, reading, writing, vocab, grammar`, `attitude` 는 `participation, focus, homework` 만 허용하며 값은 **1~5 정수**입니다. **자료로 뒷받침되지 않는 항목은 보내지 말고 비워 두세요.** (앱에서 선생님이 직접 채웁니다)
- 글 항목은 각각 3000자까지입니다. 한 번에 최대 100명, 본문 100KB 까지입니다.
- 평가서가 없으면 새로 저장(`inserted`), 손대지 않은 AI 초안이면 수정(`updated`), 선생님이 쓰거나 완료한 평가서면 건너뜀(`skipped`). 잘못된 항목은 그 항목만 `errors` 에 담기고 나머지는 저장됩니다.
- 오류: 401(토큰 없음/틀림), 400(형식 오류), 405(메서드 오류), 413(너무 큼), 502(DB 연결 문제).

## 앱에서
- **월말평가서** 목록과 상세에 보라색 **AI 초안** 배지가 붙습니다.
- 내용을 확인·수정해서 저장하면 선생님 작성으로 바뀌고 배지가 사라집니다. 상태를 '완료'로 바꾸면 확정입니다.

## 예약 작업 프롬프트 예시 (매월 말일 저녁)
```
영어 공부방 월말평가서 초안을 만드세요. 학생 실명은 알 수 없으며 추측하지 않습니다.
1. GET https://rachel-english.ecarusblue.workers.dev/api/evaluation-source 를 Authorization: Bearer <토큰> 헤더로 호출합니다. (연·월 생략 = 이번 달)
2. students 중 existing 이 null 이거나 {"source":"ai","status":"작성중"} 인 학생만 작성합니다. 나머지는 건너뜁니다.
3. 학생마다 아래 자료로만 작성합니다. 자료에 없는 내용은 쓰지 않습니다.
   - ratings: 단어시험 점수(tests·test_trend)가 있을 때만 vocab 을 매기고, 나머지 영역(듣기·말하기·읽기·쓰기·문법)은 선생님 코멘트에 분명한 근거가 있을 때만 매깁니다. 근거가 없으면 보내지 않습니다.
   - attitude: homework 는 숙제 완료/일부/미제출 횟수로, participation 은 출석·지각·결석으로 매깁니다. focus 는 코멘트에 근거가 있을 때만 매깁니다.
   - achievement(이달의 성취): 교재 진도(books), 시험 추이, 선생님 코멘트의 긍정적 내용. 2~4문장.
   - improvement(보완할 점): 숙제·출석·시험에서 보이는 약점과 선생님 코멘트. 2~3문장, 부드러운 표현.
   - next_plan(다음 달 학습 계획): books 의 current_unit 과 lessons 의 next_plan 을 근거로 구체적으로. 1~3문장.
   - parent_note(학부모께 드리는 말씀): 가정에서 도울 수 있는 일 1~2문장. 정중한 한국어 존댓말.
   - 글 안에서는 학생을 "S01" 같은 가명이 아니라 "학생" 또는 "자녀분"으로 부릅니다.
4. POST /api/evaluations 로 items(alias, year, month, ratings, attitude, achievement, improvement, next_plan, parent_note)를 보냅니다. year, month 는 읽기 응답의 값을 그대로 씁니다.
5. 응답의 inserted / updated / skipped / errors 를 요약해서 보고합니다.
```
