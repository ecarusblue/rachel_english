# 라이팅 첨삭 (Claude 가 앱에서 바로 첨삭)

학생 화면의 **라이팅** 탭에서 학생이 쓴 영어 글의 사진·문서를 올리면, Worker(`POST /api/correct`)가 Claude 로 원문을 읽고 문장별로 첨삭해서 화면에 보여 줍니다. 결과는 학생별로 저장되고, 학부모용 A4 인쇄·PDF 공유도 됩니다.

앞의 예약 작업 API(추천·월말평가서)와 달리, 이 기능은 **선생님이 앱에서 누를 때마다 즉시 Claude API 를 호출**합니다. 그래서 Anthropic API 키가 필요하고 사용한 만큼 요금이 나옵니다.

## 1. 설정 (한 번만)
1. Supabase SQL Editor 에서 최신 `schema.sql` 을 실행합니다. (`writings` 테이블과 비공개 Storage 버킷 `writings` 가 생깁니다)
2. [console.anthropic.com](https://console.anthropic.com) 에서 API 키를 만듭니다. (월 사용 한도도 같이 정해 두세요)
3. Cloudflare 대시보드 → 이 Worker(`rachel-english`) → **Settings → Variables and Secrets** 에서 **Secret** 으로 추가합니다.
   - `ANTHROPIC_API_KEY` = 위에서 만든 키 (이 키는 채팅·저장소에 올리지 마세요)
   - (선택) `CORRECT_MODEL` = 사용할 모델 ID. 비우면 `claude-sonnet-5-5`
4. 다시 배포합니다. 키를 넣기 전에는 첨삭 때 "ANTHROPIC_API_KEY 가 설정되지 않았어요"가 나옵니다.

내 컴퓨터에서 Worker 까지 같이 시험하려면 프로젝트 폴더에 `.dev.vars` 파일(저장소에서 제외됨)을 만들고 `ANTHROPIC_API_KEY=...` 를 적은 뒤 `node build.mjs && npx wrangler dev` 를 실행하세요. (`python http.server` 로는 `/api/` 가 없어서 첨삭이 동작하지 않습니다)

## 2. 쓰는 법
- 올릴 수 있는 것: 사진(JPG·PNG 등, 폰 카메라 가능), PDF(8MB까지), 워드(.docx), 텍스트(.txt), 또는 글 직접 붙여넣기. 최대 8개, 여러 쪽이면 순서대로.
- 사진은 올리기 전에 브라우저에서 긴 변 2000px 로 줄입니다.
- 결과: Claude 가 읽은 원문, 문장별 교정(틀린 곳 취소선 → 고친 곳 강조)과 쉬운 한국어 이유, 영역별 점수(내용·문법·어휘·구성, 1~5), 총평·잘한 점·더 노력할 점.
- 손글씨를 잘못 읽었으면 **원문 고쳐서 다시 첨삭** 으로 글자만 고쳐 다시 돌릴 수 있습니다. 학생의 틀린 철자는 그대로 두세요.
- **선생님 한마디**를 적어 저장하면 인쇄·PDF 에 같이 들어갑니다.
- AI 결과이므로 학부모께 보내기 전에 선생님이 한 번 확인하세요.

## 3. 보안·개인정보
- `/api/correct` 는 앱에 로그인한 선생님의 Supabase 로그인 토큰이 있어야만 동작합니다. (Worker 가 토큰을 Supabase 에 확인)
- Anthropic 키는 Worker 비밀값에만 있고 브라우저에는 내려가지 않습니다.
- 올린 사진·글은 첨삭을 위해 Anthropic API 로 전송됩니다. 학생 이름·학교·연락처가 사진에 나오지 않게 하세요. 프롬프트도 결과에 개인정보를 쓰지 않도록 지시합니다. (학생 이름은 Claude 에 보내지 않고, 학년만 보냅니다.)
- 원본 파일은 비공개 버킷 `writings` 에 `<선생님 id>/<학생 id>/<첨삭 id>/번호` 경로로 저장되고, 본인 폴더만 접근할 수 있습니다(RLS). 첨삭을 삭제하면 파일도 함께 지워집니다.
- 학생이 퇴원하거나 삭제되면 `writings` 행은 함께 지워지지만 Storage 파일은 남을 수 있으니, 학생을 지우기 전에 첨삭 기록을 먼저 삭제하세요.
