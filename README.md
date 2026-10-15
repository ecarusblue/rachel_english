# 공부방 진도표

영어 공부방 선생님 전용 학생 진도 관리 앱입니다. 빌드 과정이 없는 정적 웹앱(HTML/CSS/JS)이고, 데이터는 Supabase(Postgres)에 저장됩니다.

**기능**
- 전체 현황: 재원생별 교재 진도 바, 최근 수업일, 최근 수업 진도와 다음 예정, 30일 출석, 90일 시험 평균, 기록이 끊긴 학생 표시
- 학생 상세: 교재 진도(+1/-1/직접 입력), 수업 기록(출결·숙제·메모), 시험·단어 점수와 추이 그래프
- 수업 진도: 수업마다 교재와 단원 범위(예: Unit 6–7), 학습 내용, 다음 수업 예정 진도를 기록하고, 저장할 때 교재 진도를 종료 단원으로 함께 갱신(결석 제외)
- 주간·월간 요약: 재원생 전체의 수업 횟수·교재 범위·숙제 완료율·시험 평균·다음 예정·안내문 발송 여부를 한 표로 보고, 학생을 눌러 리포트로 이동
- 수업 추천: 학생 화면의 "수업 추천" 탭에서 Claude 예약 작업이 저장한 제안을 확인하고, 수업 기록에 반영(채택/수정) 또는 거절
- 리포트: 기간(주·월·직접) 요약과 학부모 안내문 초안 복사, 인쇄/PDF 저장, 발송 기록 표시
- 교재 관리, JSON 백업 내려받기, 인쇄(진도표 출력)
- 선생님 1계정 로그인 + DB 수준 접근 제한(RLS)

## 1. Supabase 설정 (약 10분)

1. [supabase.com](https://supabase.com)에서 새 프로젝트를 만듭니다. 리전은 **Northeast Asia (Seoul)** 을 권장합니다.
2. 왼쪽 메뉴 **SQL Editor** 에서 `schema.sql` 전체를 붙여넣고 **Run** 합니다. 테이블과 접근 제한(RLS)이 한 번에 만들어집니다.
3. **Authentication → Users** 에서 선생님 계정(이메일 + 비밀번호)을 직접 추가합니다. 이메일 확인 단계는 건너뛰도록(auto confirm) 체크하세요.
4. **중요: 외부 가입 막기.** Authentication 설정(Sign In / Providers 등)에서 **새 사용자 가입 허용(Allow new users to sign up)을 끕니다.** 켜 둔 채로 두면 누구나 계정을 만들 수 있습니다. 메뉴 이름은 버전에 따라 조금 다를 수 있습니다.
5. **Project Settings → API** 에서 Project URL 과 공개용 키(anon 또는 publishable)를 복사해 둡니다. 3단계에서 Cloudflare 환경변수로 넣습니다.
   - `service_role` / secret 키는 절대 쓰지 마세요. 빌드 스크립트가 거부합니다.
   - 공개용 키는 브라우저에 노출돼도 되도록 설계된 키이며, 실제 보호는 RLS가 담당합니다.
   - 키를 코드에 직접 적지 않으므로 저장소가 공개 상태여도 키가 올라가지 않습니다.

**이미 예전 `schema.sql` 을 실행했다면:** 새 `schema.sql` 을 SQL Editor 에서 다시 실행하면 됩니다. 기존 데이터는 그대로 두고 새 컬럼(`lessons` 의 수업 진도·숙제 내용)과 새 테이블(`recommendations`, `report_logs`)만 추가됩니다.

## 2. 내 컴퓨터에서 먼저 확인

```
SUPABASE_URL="https://xxxx.supabase.co" SUPABASE_KEY="공개용키" node build.mjs
cd dist && python3 -m http.server 8000
```

(Windows PowerShell 은 `$env:SUPABASE_URL="..."; $env:SUPABASE_KEY="..."; node build.mjs`)

브라우저에서 `http://localhost:8000` 을 열고 로그인해 보세요. 만들어진 `dist/` 는 `.gitignore` 로 제외됩니다.
순서는 **교재 관리 → 학생 추가 → 교재 배정 → 수업 기록/시험 입력** 이 편합니다.

## 3. Cloudflare Pages 배포 (무료)

GitHub 저장소를 연결하면 push 할 때마다 자동 배포됩니다.

1. Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git** 에서 이 저장소를 고릅니다.
2. 빌드 설정:
   - Framework preset: **None**
   - Build command: `node build.mjs`
   - Build output directory: `dist`
3. **Environment variables (Production)** 에 두 개를 추가합니다.
   - `SUPABASE_URL` = Supabase Project URL
   - `SUPABASE_KEY` = 공개용(anon / publishable) 키
4. **Save and Deploy** 후 발급된 `*.pages.dev` 주소로 접속해 로그인합니다.

환경변수를 바꾸면 다시 배포해야 반영됩니다. `_headers` 파일이 보안 헤더(CSP 포함)를 자동으로 적용하고, 검색 엔진 색인도 막습니다.
가입을 막고 RLS 를 적용한 상태인지(1단계 3~4번) 꼭 확인하세요.

## 운영할 때 알아둘 점

- **자동 일시 중지:** Supabase 무료 프로젝트는 약 1주일 활동이 없으면 중지됩니다. 매주 한 번 이상 로그인해 쓰면 보통 문제없고, 중지되면 Supabase 대시보드에서 복구할 수 있습니다.
- **백업:** 무료 플랜에는 자동 백업이 없습니다. 사이드바의 **백업(JSON)** 으로 주 1회 정도 내려받아 두세요. 이 파일에는 학생 정보가 들어 있으니 보관에 유의하세요.
- **학생 개인정보:** 미성년자 정보를 다루므로 이름·학년·학습 기록 위주로만 쓰고, 연락처·주소·주민번호 같은 정보는 입력하지 않는 것을 권장합니다. 학부모 안내나 동의 등 법적 요건은 개인정보 보호 관련 규정을 직접 확인하세요.
- **비밀번호:** 선생님 계정 비밀번호는 다른 서비스와 겹치지 않게 정하세요. 이 계정이 모든 학생 데이터의 열쇠입니다.
- **사용 조건:** 무료 플랜의 약관(상업적 사용 가능 여부, 한도)은 서비스마다 달라서 바뀔 수 있으니, 운영 전에 Cloudflare 와 Supabase 의 현재 약관을 확인하세요.

## 파일 구성

| 파일 | 설명 |
|---|---|
| `index.html` | 화면 뼈대 |
| `style.css` | 스타일 (다크 모드, 인쇄 지원) |
| `app.js` | 앱 로직 |
| `config.js` | 자리표시자(저장소용). 배포 때는 `build.mjs` 가 `dist/config.js` 를 새로 만듭니다 |
| `build.mjs` | 환경변수로 `dist/` 생성 (secret 키 차단) |
| `_headers` | Cloudflare Pages 보안 헤더 |
| `schema.sql` | DB 테이블 + RLS 정책 + 추천 API 함수 |
| `src/worker.js` | 추천 API (`/api/ping`, `/api/progress`, `/api/recommendations`). 빌드 때 `build/worker.js` 로 만들어짐 |
| `wrangler.jsonc` | Cloudflare 배포 설정 (Worker + dist 정적 파일) |

`recommendations` 테이블은 AI 추천 이력 저장용으로 DB에만 준비되어 있고, 현재 화면(`app.js`)에서는 아직 사용하지 않습니다.

## 진도 추천 API

Claude 예약 작업이 현재 진도를 읽고 추천을 저장하는 API 입니다. 설정과 사용법은 [docs/recommend-api.md](docs/recommend-api.md) 를 보세요.

## 나중에 확장하기 (선택)

- 학부모/학생 조회: 계정을 분리하고 RLS 정책을 학생·보호자 기준으로 추가해야 합니다. (지금은 선생님 전용)
- 학생이 늘어 데이터가 많아지면 전체 현황 쿼리를 DB 뷰로 옮기는 것을 고려하세요.
