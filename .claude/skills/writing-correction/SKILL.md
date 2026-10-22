---
name: writing-correction
description: 학생이 쓴 영어 글(사진·PDF·워드·텍스트)을 읽고 원문을 DB에 저장한 뒤 첨삭 결과를 저장한다. "OO 영어 라이팅 첨삭해줘"처럼 학생 이름과 함께 요청할 때 사용.
---

# 영어 라이팅 첨삭 (Rachel English)

선생님이 학생 이름과 함께 글 사진·문서를 주면: **원문 추출 → DB 저장 → 첨삭 → DB에 결과 저장**. 결과는 웹앱의 학생 화면 "라이팅" 탭에 나타난다. 원본 파일은 저장하지 않고 원문 텍스트만 저장한다.

## 준비물
- 환경변수 `RACHEL_API_TOKEN` (추천·평가서 API 와 같은 토큰). 없으면 선생님께 설정을 안내하고 멈춘다. 토큰 값을 출력하거나 파일에 쓰지 않는다.
- 주소: `https://rachel-english.ecarusblue.workers.dev` (`/api/ping` 으로 연결 확인)
- 한글이 섞인 JSON 은 셸 인자로 넘기지 말고 **임시 파일에 Write 한 뒤 `curl --data-binary @파일`** 로 보낸다. (Windows PowerShell 에서는 `curl.exe`)

## 절차
1. **학생 찾기** — `GET /api/writing/student?name=<이름>` (헤더 `Authorization: Bearer $RACHEL_API_TOKEN`)
   - 결과 `data` 가 배열 `[{id, name, grade, active}]`. 0명이면 이름을 다시 묻고, 2명 이상이면 후보를 보여 주고 선생님께 고르게 한다. 이름이 정확히 한 명일 때만 진행.
2. **원문 읽기** — 이미지·PDF 는 직접 보고, 워드·텍스트는 내용을 읽는다.
   - 학생의 **틀린 철자·문법·대문자를 그대로** 옮긴다. 고치지 않는다. 문단은 빈 줄로 구분.
   - 읽기 어려운 단어는 가장 그럴듯하게 읽고, 어디를 어떻게 읽었는지 기록해 둔다(`unreadable`). 없는 글을 지어내지 않는다.
   - 글에 학생 이름·학교·연락처가 있으면 `[이름]`처럼 가린다.
3. **원문 저장** — `POST /api/writing` 본문 `{"student_id": "...", "ocr_text": "원문", "title": "제목(선택)", "written_on": "YYYY-MM-DD(선택, 기본 오늘)"}` → `data.id` 를 받아 둔다.
   - 저장 직후 선생님께 읽은 원문과 `unreadable` 을 짧게 보여 준다. 크게 의심되는 부분이 있으면 이때 확인을 구하고, 아니면 바로 4로 진행한다.
4. **첨삭** — 아래 형식으로 만든다.
5. **결과 저장** — `POST /api/writing/correction` 본문 `{"id": "<3의 id>", "result": {...}, "model": "Claude(세션)"}`. 원문을 고쳤다면 `"ocr_text"` 도 함께 보내 갱신한다. 같은 id 로 다시 보내면 덮어쓴다.
6. 선생님께 총평 요약과 "웹앱 → 학생 → 라이팅 탭에서 확인·인쇄할 수 있다"고 알린다. 실패 응답(`ok:false`)은 오류 내용을 그대로 알린다.

## 첨삭 형식 (`result`)
```json
{
  "transcript": "학생이 쓴 그대로의 원문",
  "unreadable": ["3번째 줄의 단어를 friend 로 읽었어요"],
  "sentences": [
    {
      "original": "Yesterday I go to park with my freind.",
      "corrected": "Yesterday I went to the park with my friend.",
      "notes": [
        {"type": "grammar", "wrong": "go", "right": "went", "explanation": "어제 일이니까 과거형 went 를 써요."},
        {"type": "spelling", "wrong": "freind", "right": "friend", "explanation": "i 가 e 보다 먼저 와요."}
      ]
    },
    {"original": "We played soccer.", "corrected": "We played soccer.", "notes": []}
  ],
  "scores": {"content": 4, "grammar": 2, "vocabulary": 3, "organization": 4},
  "summary": "학부모께 드리는 3~5문장 총평 (한국어)",
  "strengths": ["잘한 점 1~3개"],
  "improvements": ["더 노력할 점 1~3개"]
}
```
- `type`: grammar · spelling · vocabulary · punctuation · capitalization · word_order · expression
- `sentences` 는 원문의 **모든 문장**을 순서대로. 맞는 문장은 `corrected` 를 `original` 과 같게, `notes` 는 빈 배열.
- `wrong` 은 `original` 에서, `right` 는 `corrected` 에서 **그대로 복사한** 부분이어야 화면에서 강조된다.
- `scores` 는 1~5 정수(5가 최고), **그 학생의 학년 수준** 기준. 후하게 주지 않는다.
- 최소한만 고친다: 학생의 뜻과 말투를 살리고, 맞는 문장은 멋을 부리려고 바꾸지 않는다.
- 설명은 학생이 이해할 쉬운 한국어, 1~2문장.
- 영어 문장이 없으면 `sentences` 를 빈 배열로 하고 `summary` 에 그 사실을 쓴다.
- 서버가 검사하는 것: `sentences`(배열), `scores`(네 항목 모두 1~5), `summary`(문자열).
