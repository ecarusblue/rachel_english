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
   - **원본 보관:** 선생님이 준 사진·문서가 파일 경로로 있으면 `C:\Users\ecaru\workspace\upload` 폴더에 **복사**한다(원본은 지우지 않는다). 폴더가 없으면 만든다. 파일 이름은 `YYYY-MM-DD_학생이름_글id앞8자.확장자`, 여러 장이면 `..._1.jpg`, `..._2.jpg` 처럼 번호를 붙인다. 같은 이름이 이미 있으면 덮어쓰지 말고 번호를 바꾼다.
   - 채팅에 붙여넣은 이미지처럼 **파일 경로가 없으면** 복사할 수 없으므로, 보관되지 않았다고 선생님께 한 줄로 알린다. (파일을 만들어 내거나 추측한 경로를 쓰지 않는다.)
   - 복사에 실패해도 첨삭은 계속 진행하고, 실패 사실만 알린다. DB에는 원본 파일을 올리지 않는다(원문 텍스트만 저장).
   - 저장 직후 선생님께 읽은 원문과 `unreadable` 을 짧게 보여 준다. 크게 의심되는 부분이 있으면 이때 확인을 구하고, 아니면 바로 4로 진행한다.
4. **첨삭** — 아래 형식으로 만든다.
5. **결과 저장** — `POST /api/writing/correction` 본문 `{"id": "<3의 id>", "result": {...}, "model": "Claude(세션)"}`. 원문을 고쳤다면 `"ocr_text"` 도 함께 보내 갱신한다. 같은 id 로 다시 보내면 덮어쓴다.
6. 선생님께 총평 요약, 원본을 보관한 파일 경로(보관했다면), "웹앱 → 학생 → 라이팅 탭에서 확인·인쇄할 수 있다"를 알린다. 실패 응답(`ok:false`)은 오류 내용을 그대로 알린다.

## 한 시험지의 여러 영역은 한 글로 저장
시험지에 영역이 여러 개이거나 사진이 여러 장이어도, **같은 학생의 같은 시험지는 글 하나(`/api/writing` 한 번, `/api/writing/correction` 한 번)로 저장**한다. 영역별로 글을 나누어 저장하지 않는다. (나중에 합치려면 DB 를 직접 고쳐야 한다.)
- **제목:** 시험지 이름과 영역을 적는다. 예: `Placement Test S1·S2 (우리말 해석 + 영어 단어 배열)`. `written_on` 은 시험지에 적힌 날짜가 있으면 그 날짜(올해 기준), 없으면 오늘.
- **`ocr_text`:** 영역마다 `[S1 영어를 우리말로]`, `[S1 단어 배열]` 같은 **구역 제목 줄**을 넣고, 쪽·영역 사이는 시험지 순서대로 이어 붙인다. 구역 제목은 문장이 아니므로 `sentences` 에 넣지 않는다. `transcript` 는 `ocr_text` 와 같게 둔다.
- **`sentences`:** **시험지 순서대로** 모든 문항을 한 배열에 넣는다.
- **영어 → 우리말 해석 문항:** `original` 은 `영어 문장 → 학생이 쓴 우리말`, `corrected` 는 `영어 문장 → 올바른 우리말`로 적는다. 예: `an ant → 개미 한마리`. 영어 부분은 그대로 두고 `wrong`/`right` 는 우리말 부분에서 고른다. 한국어 반말(~야, ~해)과 `-ㄴ다` 는 모두 정답으로 인정한다. **영어 문장이 주어 없이 동사로 시작하면 명령문**이므로 `~해라` 로 옮겨야 한다(`그린다` 는 오답).
- **답을 쓰지 못한 문항(예: `(?)`):** `original` 에 `영어 문장 → (?)` 로 적고, 올바른 해석을 `corrected` 로 보여 준다.
- **영어 단어 배열·쓰기 문항:** 학생이 쓴 영어 문장을 그대로 `original` 로 적는다.
- **`scores`·`summary`:** 영역 전체를 합쳐 한 번만 평가하고, 총평에 영역별 결과(몇 문항 중 몇 개 정확, 자주 틀린 유형)를 함께 쓴다. 해석 문항이 포함되면 `unreadable` 에 "점수는 해석과 쓰기를 합쳐서 보았어요"라는 안내를 한 줄 넣는다.
- **채점 표시:** 시험지에 선생님의 빨간 채점 표시가 있으면 참고는 하되 내용으로 직접 판단하고, 다르면 선생님께 알린다.
- **글씨를 지웠거나 흐려서 확신이 없는 문항:** 틀린 것으로 단정하지 않는다. `unreadable` 에 어느 문항을 어떻게 읽었는지 적고, 확인을 부탁한다. 선생님이 알려 주시면 `ocr_text` 와 해당 문장·총평을 함께 고쳐 다시 저장한다(DB 를 직접 고치는 경우에도 문장 `original` 이 `ocr_text` 에 그대로 들어 있어야 한다).

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
