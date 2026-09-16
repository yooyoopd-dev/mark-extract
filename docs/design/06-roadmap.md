# 06 — 로드맵

각 단계에 **검증 가능한 성공 기준**을 붙인다. 기준을 통과하지 못하면 다음 단계로 가지 않는다.

---

## 1. 프로젝트 골격 + 디자인 토큰 ✅ 완료

Electron 프로젝트 초기화, 3계층 분리, `design/index.html`에서 토큰 추출 (`styles/tokens.css`).

**검증 결과** — `npm run verify` 하나로 돌아간다.

| 기준 | 결과 |
|---|---|
| 빈 셸이 뜨고 라이트/다크 전환이 동작한다 | 통과. xvfb에서 창을 띄워 두 테마 스크린샷 확보 |
| `tokens.css`의 색 45쌍이 `design/index.html`과 일치한다 | 통과. 90개 토큰 일치. 파일 대조(`tokens:check`)와 실행 중 계산값 대조(스모크) 두 층 |
| `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true` | 통과. 소스 grep이 아니라 실행 중 `webContents.getLastWebPreferences()`에서 확인 |

**정한 것**

- 번들러를 쓰지 않는다. 렌더러가 프레임워크 없는 순수 HTML/CSS/JS라 번들할 대상이 없다. `tsc`만 쓰고 의존성은 `electron`·`electron-builder`·`typescript`·`@types/node` 넷뿐이다. (`electron-vite@5`의 peer는 `vite ^5|^6|^7`인데 현재 vite는 8.x라 맞지도 않는다.)
- 색 토큰은 `scripts/tokens.mjs`가 `design/index.html`에서 생성한다. `tokens.css`는 커밋하되 `tokens:check`가 드리프트를 잡고, 어긋나면 **빌드가 실패한다**. 손으로 옮기다 한 글자 틀리는 경로를 없앴다.
- 반지름·타이포·모션은 원본에 CSS 변수가 아니라 리터럴로 있어 생성 대상이 아니다. `base.css`에 손으로 올리되 값은 원본 그대로 뒀다.

**실측으로 정정한 것**

- Electron의 `file://`은 `<script type="module">`을 **정상적으로 싣는다.** 설계 당시 일반 브라우저처럼 CORS로 막힐 것이라 적었으나 실제로는 로드된다. 4단계에서 커스텀 프로토콜을 들일 필요가 없다.
- TypeScript 7에서 `moduleResolution: node10`과 `module: none`이 제거되었다. 각각 기본값과 `ESNext`로 바꿨다.

**미검증**: `electron-builder.yml`은 `05-packaging.md` 명세대로 작성만 했다. 리눅스 컨테이너에서 Windows portable 빌드를 돌릴 수 없어 8단계에서 확인한다.

## 2. PDF 어댑터 + JRE 동봉

`jdeps`로 모듈 결정 → `jlink` 스크립트 → PDF 어댑터 → 헬스 체크(`--export-options`).

**검증 결과** — `npm run verify:pdf` 가 단언 15개를 돌린다.

| 기준 | 결과 |
|---|---|
| 제목 계층과 표가 살아남는다 | 통과. H1·H2·H3, 표 헤더·구분행·내용 |
| 한글이 깨지지 않는다 | 통과. UTF-8, 숫자·특수문자·따옴표 보존 |
| 임시 디렉터리가 지워진다 | 통과. 성공·실패·취소 모두 `finally` 에서 |
| 동봉 JRE 를 쓴다 | 통과. 개발 경로와 **패키징 경로(`process.resourcesPath`) 모두** |
| Java 미설치 Windows | **CI 가 확인** — `debug-windows` job |

**정한 것**

- JAR 은 `@opendataloader/pdf` 를 devDependency 로 두고 빌드 때 `resources/lib/` 로 꺼낸다. 24MB 바이너리를 git 에 넣지 않으면서 `package-lock` 으로 버전을 고정한다. npm 래퍼 자체는 런타임에 쓰지 않는다 — 그건 PATH 의 `java` 를 찾는데 우리는 동봉 JRE 를 쓴다.
- 결과는 stdout 이 아니라 파일로 받는다. `--to-stdout` 이 있지만 Windows 콘솔 코드페이지의 영향을 받을 여지가 있다.
- 공유 타입(`ParseResult` 등)은 `src/shared/*.d.ts` 로 뒀다. 타입 선언뿐이라 main·preload·renderer 가 모두 쓰면서 어느 쪽에서도 JS 가 나오지 않는다.
- 앱에 `--self-test` 를 넣었다. 패키징된 뒤에야 `process.resourcesPath` 경로가 검증되고, 사용자도 GUI 없이 명령 프롬프트에서 바로 확인할 수 있다.

**실측으로 드러난 결함과 대응**

1. **한글 줄 잇기** — 기본 출력이 `섞여 있 으며` 처럼 단어 가운데 공백을 넣는다. PDF 줄바꿈에서 문단을 이을 때 공백을 넣는 동작이 한글에선 틀리다. `--keep-line-breaks` 로 받아 CJK 를 보며 직접 잇도록 했다 (→ [02](02-parser-adapters.md#한글-줄-잇기--2단계-실측-이-단계의-핵심))
2. **`--space-ratio` 는 올리면 안 된다** — 0.30 에서 정당한 공백까지 사라지고 원래 문제는 그대로다. UI 에 내보내지 않는다
3. **목록 마커 소실** — 불릿이 `-` 없는 문단으로 풀린다. 엔진 한계이며 알려진 제약으로 문서화했다

**실측치**: jlink JRE **54MB**(추정 45MB 였음), JAR 23.1MB, 변환 0.5초/1페이지.

**Windows 확인 경로**: `.github/workflows/build.yml` 의 `debug-windows` job 이 Windows JRE 로 변환을 검증하고 portable exe 를 아티팩트로 올린다. 사용자가 내려받아 `MarkExtract.exe --self-test` 또는 GUI 에 PDF 를 떨어뜨려 확인한다.

## 3. Office · PPTX 어댑터 ✅ 완료

kordoc 연결(`--omit=optional`), PPTX 자체 구현.

**검증 결과** — `npm run verify:parsers` 가 단언 **52개**를 돌린다.

| 기준 | 결과 |
|---|---|
| DOCX/XLSX/XLS/PPTX 가 표·제목 계층을 유지한다 | 통과 |
| PPTX 에 슬라이드 경계·발표자 노트·표가 나온다 | 통과 |
| kordoc 오류 코드가 UI 문구로 매핑된다 | 통과 (`ErrorCode` → 문구·버튼 표) |
| 매직 바이트 판별이 확장자가 틀려도 맞는다 | 통과 (`.pdf` 로 이름 붙인 docx → docx) |
| 패키징된 앱에서 다섯 형식이 모두 변환된다 | 통과 (5/5, `--self-test`) |

**실측으로 드러난 것**

1. **줄 잇기를 PDF 전용으로 분리했다.** 스프레드시트에서 연속한 두 줄은 서로 다른 셀이라, PDF 용 줄 잇기를 적용하면 별개 값이 한 줄로 뭉개진다. `normalizeMarkdown`(공통)과 `joinWrappedLines`(PDF 전용)를 나눴다
2. **`.npmrc` 의 `omit=optional` 은 쓸 수 없다.** TypeScript 7 의 플랫폼 바이너리가 optionalDependencies 라 tsc 가 깨진다. 대신 패키징 단계에서 걸러내 **asar 75MB → 25MB**
3. **PPTX 제목이 내용 뒤로 밀렸다.** 자리표시자가 `a:off` 를 생략하고 레이아웃에서 위치를 물려받는데 XML 만 읽는 우리는 알 수 없다. 제목을 위치와 무관하게 맨 앞으로 보낸다
4. **PPTX 도형은 `p:spTree` 직계 자식만** 본다. `getElementsByTagNameNS` 는 모든 자손을 훑어 그룹 안 도형이 중복된다

**알려진 제약**: 목록 마커가 사라지는 것은 PDF 뿐 아니라 **DOCX 도 마찬가지**다. 불릿이 `-` 없는 문단으로 풀린다.

## 4. UI 이식 ✅ 완료

사이드바·목록·뷰어·인스펙터·상태바·팔레트·다이얼로그·토스트.

**검증 결과** — 스모크가 실제로 띄운 창에서 확인한다.

| 기준 | 결과 |
|---|---|
| 1024/1366/1440/1920 에서 가로 스크롤 없음 | 통과. 각 폭 스크린샷 확보 |
| 1200px·1024px 에서 드로어 전환 | 통과. `position: absolute` 전환을 계산값으로 확인 |
| 키보드로 목록 이동·탭 전환 | 목록 ↑↓, 탭 ←→, Esc 로 드로어 닫기, Ctrl+K 팔레트 |
| 문서 상태 4종의 색이 토큰과 일치 | 통과 (색 토큰 45쌍 대조에 포함) |
| UI 를 통한 실제 변환 | 통과. 시험 자료 4종이 목록에 '완료'로 들어옴 |

**정한 것**

- **프레임 없는 창**(`frame: false`)으로 바꿨다. 디자인이 Windows 캡션바를 직접 그리므로 기본 프레임을 쓰면 캡션이 둘이 된다. 최소화·최대화·닫기는 `window:action` 채널 하나로 처리하되 main 이 값을 검사한다. 타이틀바에 `-webkit-app-region: drag` 를 준다
- **명령줄 인자로 문서를 연다.** `MarkExtract.exe 보고서.pdf` — 탐색기의 "연결 프로그램"에 해당한다. 덕분에 스모크가 테스트 전용 훅 없이 채워진 UI 를 검증할 수 있다
- **인라인 style 속성을 전부 클래스로 옮겼다.** CSP 를 `style-src 'self'` 로 잠갔기 때문에 원본의 `style="…"` 9곳이 차단됐다. `'unsafe-inline'` 을 여는 대신 값을 그대로 클래스로 옮겼다

**이식하며 드러난 것**

1. **1단계의 스크롤 버그는 원본에 이미 답이 있었다.** 원본의 `.workspace > * { min-width: 0; min-height: 0; }` 를 1단계에서 레이아웃을 직접 쓰며 빠뜨린 것이 원인이었다
2. **CSS 추출에 `<style>` 태그가 섞여 들어갔다.** 파서가 뒤따르는 `@layer od-layout` 블록을 통째로 버려 `.od-scroll { overflow-y: auto }` 가 죽었고 뷰어가 스크롤되지 않았다
3. **가로 스크롤 검사를 두 번 잘못 짰다.** `scrollWidth` 는 닫힌 드로어(`translateX(102%)`)까지 세고, `overflow: hidden` 은 프로그램적 스크롤을 막지 않으며, 루트의 computed overflow 는 뷰포트로 전파된 값이 아니다. 결국 **body 의 overflow 기전**과 **드로어를 뺀 요소의 화면 이탈** 둘로 나눠 본다

**디자인 대비 변경 (문서대로)**: 3번째 탭 '추출 필드' → '변환 로그', 인스펙터에 엔진 선택 추가·청크 슬라이더 제거·OCR 조건부 비활성.

**아직 없는 것**: 감시 폴더·내보내기(5단계), LLM 엔진(6단계), OCR(7단계). 해당 버튼은 비활성이거나 안내 토스트를 띄운다.

## 5. 변환 큐 · 감시 폴더 · 내보내기

**검증**
- 폴더를 드롭하면 지원 포맷만 큐에 들어간다
- 취소가 자식 프로세스를 실제로 죽인다 (작업 관리자로 확인)
- 재변환이 바뀐 옵션을 반영한다
- 한 문서가 실패해도 큐가 계속 진행된다
- 내보낸 파일이 BOM 없는 UTF-8이다

## 6. LLM CLI 계층 + 설정 화면

CLI 탐색, 프로바이더 4종, 모드 A 격리, 설정 화면.

> **차용 기준 (결정 14)**: llm-co-wiki에서 가져오는 것은 CLI 인자 조합·프로토콜 사실·운영 사실뿐이다. **코드는 복사하지 않고 새로 쓴다.** 재작성 범위는 CLI transport 4종, 실행 파일 탐색기, 오류 진단. 이유와 허용 경계는 [ATTRIBUTION](ATTRIBUTION.md#llm-co-wiki-차용-기준-결정-14) 참조.

**검증**
- 4개 프로바이더가 탐지되고, 없을 때 진단 리포트가 나온다
- 모드 A: 임시 폴더에 대상 1개만 있고, 종료 후 지워진다
- 모드 B: 4개 프로바이더 모두에서 변환 성공
- claude 스트림에서 텍스트 중복이 없다
- 인증 만료 시 전용 안내가 뜬다
- 성공했는데 빈 결과면 실패로 처리된다
- **실측 항목 1**: 포맷 × 프로바이더 읽기 가능 매트릭스를 채워 [03](03-llm-engine.md#포맷-미지원-시-결정-17)의 "미검증" 표를 갱신
- **실측 항목 2**: `ollama run`의 파이프 입력 종료·스트리밍 동작 확인

## 7. hybrid OCR 연동

**검증**
- 서버 구동 상태에서 스캔 PDF가 변환된다
- 서버 미구동 시 OCR 토글이 비활성이고 설정 화면으로 안내된다
- 연결 테스트가 성공·실패를 정확히 구분한다
- `--use-struct-tree`와 동시 선택 시 우선순위가 UI에 표시된다

## 8. 패키징

**검증**
- 클린 Windows VM(Java·Node 없음)에서 단일 exe가 실행된다
- 1~7단계 검증을 그 VM에서 재실행해 통과한다
- 첫 실행 지연에 스플래시·진행 표시가 나온다
- 실제 exe 크기를 재서 [05](05-packaging.md#용량)의 추정치를 실측치로 교체

---

## 확정된 운영 기본값

1단계 이후 질의응답으로 확정했다. 상세는 각 문서에 있다.

| 항목 | 값 | 문서 |
|---|---|---|
| llm-co-wiki 차용 | 사실만 인용, 코드 복사 없음 | [ATTRIBUTION](ATTRIBUTION.md#llm-co-wiki-차용-기준-결정-14) |
| Mark Extract 라이선스 | 오픈소스 라이선스 미부여 (사내 전용) | [ATTRIBUTION](ATTRIBUTION.md#mark-extract-자체-라이선스-결정-18) |
| 코드 서명 | 없음 | [05](05-packaging.md#코드-서명-없음-결정-19) |
| 자동 업데이트 | 없음 (파일 교체 배포) | [05](05-packaging.md#자동-업데이트-없음-결정-20) |
| 대상 아키텍처 | x64만 | [05](05-packaging.md#x64만-결정-23) |
| 변환 이력 보존 | 1,000건 초과 시 완료 항목부터 정리 | [05](05-packaging.md#데이터-저장-위치) |
| 문서 크기 상한 | 500MB (설정 변경 가능) | [02](02-parser-adapters.md#경계-조건) |
| PPTX 범위 | 텍스트·표·노트·이미지·차트 | [02](02-parser-adapters.md#범위-결정-24) |
| LLM 프롬프트 검수 | 앱은 열람·복사만 제공 | [04](04-ui-spec.md#llm) |

## 구현 중 실측할 항목

미결이 아니라 검증 과제다. 현재 문서에 "미검증"으로 표시되어 있으며, 해당 단계에서 실측치로 교체한다.

| 항목 | 단계 | 현재 상태 |
|---|---|---|
| 포맷 × 프로바이더 읽기 가능 매트릭스 | 6 | claude의 PDF·DOCX 외 전부 미검증 |
| `ollama run` 파이프 입력 종료·스트리밍 동작 | 6 | 실행 확인 안 함 |
| `jdeps` 기반 JRE 모듈 구성 | 2 | `java.desktop` 포함 여부 미확정 |
| 실제 exe 크기 | 8 | 약 110~130MB로 추정만 함 |
