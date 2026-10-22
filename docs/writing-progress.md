# 라이팅 첨삭 기능 — 진행 요약

학생이 쓴 영어 글(사진·문서)을 Claude가 읽고 첨삭한 결과를 학생별로 저장해 웹앱에서 보고 인쇄하는 기능. 이 문서는 지금까지의 구현 상태와 남은 일을 정리한 것이다. (작성일 2026-10-22, 아직 커밋 전)

## 1. 목표와 결정 사항
- 원문(OCR)·문장별 교정과 이유·점수와 총평·학부모용 인쇄/PDF를 모두 제공한다.
- 저장은 DB에 하고, **원본 이미지는 저장하지 않고 원문 텍스트만** 저장한다. (처음 만든 앱 직접 방식에는 원본 저장 코드가 있다.)
- 주 사용 환경은 Claude Code·데스크톱 앱이고, **Claude 구독 사용량**으로 처리한다. (API 키·추가 요금 없음)

## 2. 구현한 두 가지 경로
같은 `writings` 테이블을 공유한다.

| | A. Claude 세션 (주력) | B. 앱에서 바로 |
|---|---|---|
| 방법 | 세션에서 사진·학생 이름과 "첨삭해줘" | 라이팅 탭의 "+ 라이팅 첨삭" 버튼 |
| AI 호출 | 세션의 Claude (구독 사용량) | Worker가 Anthropic API 호출 (키·요금 필요) |
| 흐름 | 학생 찾기 → 원문 저장 → 첨삭 → 결과 저장 | 업로드 → 즉시 첨삭 → 저장 |
| 원본 파일 | 저장 안 함 | 비공개 Storage에 저장 |
| 문서 | [writing-session.md](writing-session.md) | [writing-api.md](writing-api.md) |

## 3. 변경된 파일
| 파일 | 내용 |
|---|---|
| `schema.sql` | `writings` 테이블, 비공개 버킷 `writings`와 RLS, 세션용 DB 함수 `api_find_student` · `api_save_writing` · `api_save_correction` (토큰 검사 `_api_owner` 공용) |
| `src/worker.js` | 세션용 토큰 API `GET /api/writing/student`, `POST /api/writing`, `POST /api/writing/correction` / 앱 직접용 `POST /api/correct` (로그인 토큰 확인 후 Anthropic 호출) |
| `app.js` | 학생 화면 "라이팅" 탭: 목록, 업로드 창(사진 축소·PDF·워드·텍스트·붙여넣기), 결과 화면, "첨삭 대기" 상태, 원문 수정 후 재첨삭, 선생님 한마디, 인쇄·PDF 미리보기, 삭제 |
| `style.css` | 라이팅 탭과 인쇄용 스타일 |
| `_headers` | 사진 표시를 위해 CSP `img-src`에 `blob:`, `https://*.supabase.co` 추가 |
| `sw.js` | 캐시 버전 v21 |
| `.claude/skills/writing-correction/SKILL.md` | Claude Code가 따르는 작업 절차와 결과 JSON 형식 |
| `docs/writing-api.md`, `docs/writing-session.md`, `README.md`, `.gitignore` | 설명 문서, `.dev.vars` 제외 |

## 4. 결과 데이터 형식 (`writings.result`)
`transcript`, `unreadable[]`, `sentences[{original, corrected, notes[{type, wrong, right, explanation}]}]`, `scores{content, grammar, vocabulary, organization}`(1~5), `summary`, `strengths[]`, `improvements[]`. 원문만 저장되고 `result`가 `{}`이면 앱에서 "첨삭 대기"로 표시된다.

## 5. 확인한 것과 확인하지 못한 것
확인함 (내장 브라우저, 가짜 DB·가짜 응답):
- `app.js`가 오류 없이 로드되고, 목록·결과 화면·인쇄 미리보기(A4)가 정상 표시된다.
- 업로드 흐름(사진 축소 → 서버 호출 → 저장)과 워드(.docx) 텍스트 추출이 동작한다.
- 새 Worker 엔드포인트가 인증 없으면 401, 잘못된 메서드면 405를 돌려주고 올바른 요청은 DB 함수에 전달한다.
- "첨삭 대기" 목록과 상세 화면이 정상이다.

확인하지 못함:
- 새 DB 함수(SQL)는 Supabase에 실행하지 않아 실제 동작을 보지 못했다.
- 실제 Claude 호출(앱 직접 방식, 세션 방식 모두)은 해 보지 못했다.
- 이 PC에 Node가 없어 Worker를 Node에서 실행하거나 빌드해 보지 못했다.

## 6. 처음 쓰기 전에 할 일
1. 최신 `schema.sql`을 Supabase SQL Editor에서 실행한다.
2. 추천 API용 토큰을 환경변수 `RACHEL_API_TOKEN`으로 설정하고 Claude Code를 다시 시작한다. (토큰은 채팅에 붙여넣지 않는다)
3. Worker를 배포한다. 연결 확인은 `/api/ping`.
4. (앱 직접 방식을 쓸 때만) Worker Secret `ANTHROPIC_API_KEY`를 설정한다.

## 7. 알아둘 점
- 사진·글은 Claude(Anthropic)로 전송된다. 학생 이름·학교·연락처를 가리도록 지침에 적었지만 사진 자체는 전송된다.
- 앱의 "원문 고쳐서 다시 첨삭" 버튼은 API 키가 필요하다. 키 없이는 세션에서 다시 시켜야 한다.
- 학생을 삭제하기 전에 그 학생의 첨삭 기록을 먼저 지워야 Storage에 원본 파일이 남지 않는다. (앱 직접 방식으로 올린 경우)

## 8. 남은 일 / 논의 중
- **claude.ai·모바일 지원:** 현재 REST 방식은 Claude Code·데스크톱 앱 전용이다. 채팅·모바일에서는 Worker에 `/mcp` 엔드포인트(원격 MCP)를 추가해 커스텀 커넥터로 등록하는 방법이 있다. 인증은 비밀 경로(간단하지만 약함)와 OAuth(안전하지만 작업량 큼) 중 선택이 필요하다. 커스텀 커넥터의 요금제 조건은 직접 확인이 필요하다.
- 위 6번 설정 후 실제 첨삭으로 엔드 투 엔드 시험.
- 이 변경 전체의 커밋.
