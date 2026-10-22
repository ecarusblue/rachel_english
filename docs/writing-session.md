# 라이팅 첨삭 — Claude 세션(Claude Code·데스크톱 앱)으로 하기

API 키·추가 요금 없이 **Claude 구독 사용량**으로 첨삭하는 방법입니다. 세션에서 사진·문서와 학생 이름을 주고 "영어 라이팅 첨삭해줘"라고 하면 Claude 가 원문을 읽어 DB 에 저장하고, 첨삭한 뒤 같은 행에 결과를 저장합니다. 웹앱 학생 화면의 **라이팅** 탭에서 보고 인쇄합니다. (원본 파일은 저장하지 않고 원문 텍스트만 저장)

작업 순서와 JSON 형식은 프로젝트의 `.claude/skills/writing-correction/SKILL.md` 에 있어서, 이 폴더에서 Claude Code 를 열면 Claude 가 따라 합니다.

## 설정 (한 번만)
1. 최신 `schema.sql` 을 Supabase SQL Editor 에서 다시 실행합니다. (`writings` 테이블과 함수 `api_find_student`·`api_save_writing`·`api_save_correction` 이 생깁니다)
2. 토큰은 [수업 추천 API](recommend-api.md)의 것을 그대로 씁니다. 아직 없으면 그 문서의 1단계대로 만드세요.
3. 토큰을 환경변수 `RACHEL_API_TOKEN` 으로 설정합니다. (Windows PowerShell: `[Environment]::SetEnvironmentVariable("RACHEL_API_TOKEN","토큰","User")` 후 Claude Code 를 다시 시작) 채팅에 토큰을 붙여넣지 마세요.
4. Worker 를 배포합니다. 연결 확인: `curl https://rachel-english.ecarusblue.workers.dev/api/ping`

## 쓰는 법
Claude Code 에 사진을 끌어다 놓거나 파일 경로를 주고: **"하준이 영어 라이팅 첨삭해줘"**

앱에 "첨삭 대기"로 보이는 글은 원문만 저장된 상태입니다. 세션에서 "방금 글 첨삭해줘"라고 하면 이어서 채웁니다.

## API (토큰, Worker)
| 요청 | 설명 |
|---|---|
| `GET /api/writing/student?name=이름` | 이름으로 학생 찾기 `[{id,name,grade,active}]` |
| `POST /api/writing` `{student_id, ocr_text, title?, written_on?}` | 원문 저장 → `{id}` |
| `POST /api/writing/correction` `{id, result, model?, ocr_text?}` | 첨삭 결과 저장 (같은 id 는 덮어씀) |

토큰으로는 이 세 가지만 할 수 있습니다. 학생·글 삭제, 다른 표 읽기는 불가능합니다. 학생 이름을 돌려주는 것은 `student` 조회뿐입니다.

## 개인정보
사진과 글은 Claude(Anthropic)로 전송됩니다. 글에 학생 이름·학교·연락처가 있으면 가려서 저장하도록 지침에 적어 두었습니다.
