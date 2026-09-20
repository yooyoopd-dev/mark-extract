# 02 — 파서 어댑터

## 공통 계약

어댑터는 3개뿐이며 모두 같은 인터페이스를 따른다. 호출자(큐)는 어느 어댑터인지 알 필요가 없다.

```ts
interface ParseRequest {
  filePath: string
  options: DocOptions        // 인스펙터에서 온 문서별 옵션
  signal: AbortSignal
  onProgress?: (current: number, total: number) => void
}

interface ParseResult {
  ok: boolean
  markdown: string           // ok === false 이면 "" 
  warnings: Warning[]        // 건너뛴 요소, 잘린 표 등 — 변환은 성공
  log: LogEntry[]            // 변환 로그 탭 원본 (엔진·인자·소요시간·stderr)
  meta: { pages?: number; engine: string; elapsedMs: number }
  error?: { code: ErrorCode; message: string; actions: RetryAction[] }
}
```

`error.actions`는 실패 화면의 버튼이 된다 (예: `retry-with-ocr`, `retry-mode-b`, `retry-plain`). 사유만 있고 행동이 없는 실패는 만들지 않는다.

---

## PDF — opendataloader-pdf

### 실행 방식

동봉한 JRE로 동봉한 JAR을 직접 실행한다.

```
<app>/resources/jre/bin/java.exe
  -Djava.awt.headless=true
  -jar <app>/resources/lib/opendataloader-pdf-cli.jar
  <입력파일> --format markdown --output-dir <임시디렉터리> [옵션…]
```

npm 패키지 `@opendataloader/pdf`의 래퍼(`dist/index.js`)는 `const command = "java"`로 **PATH의 java**를 찾는다. 동봉 JRE를 쓰려면 자식 프로세스의 `PATH` 앞에 `resources/jre/bin`을 붙이거나, 래퍼를 거치지 않고 위처럼 직접 실행한다. **직접 실행을 기본으로 한다** — 의존성 하나가 줄고 java 경로가 명시적이다.

### 출력 회수: stdout이 아니라 파일

`--to-stdout` 플래그가 있지만(2.5.8 `ConvertOptions.toStdout`) **파일 경유를 기본으로 한다.** 이유 둘:

1. Windows 콘솔 코드페이지 때문에 한글이 stdout에서 깨질 여지가 있다. 파일은 UTF-8로 쓰이고 우리가 UTF-8로 읽으면 끝이다.
2. `--image-output external`로 뽑은 이미지 파일을 함께 회수해야 하는데, 그건 어차피 디렉터리 단위 작업이다.

산출 파일 이름은 입력 파일명의 **마지막 세 글자를 `md`로 치환**한 것이다 (`report.pdf` → `report.md`). 매 변환마다 새 임시 디렉터리를 쓰므로 그 디렉터리의 `.md` 파일을 읽으면 된다.

### 헬스 체크 — 2단계 실측

**이 CLI에는 `--version` 플래그가 없다.** 실제로 던져 보면 `Unrecognized option: --version` 과 usage 배너를 내고 **exit 2** 로 끝난다. 이걸로 확인하면 정상 설치를 고장으로 오판한다.

`--export-options` 를 쓴다. 실측 결과 **exit 0 이고 옵션 30개를 담은 JSON** 을 내놓는다. 문자열을 뒤지는 대신 **JSON 을 파싱해 `options` 배열이 비지 않았는지** 본다. 이쪽이 판정이 분명하다.

### 인스펙터 옵션 ↔ CLI 플래그

| 인스펙터 | 플래그 | 값 |
|---|---|---|
| 표 감지 방식 | `--table-method` | `default`(테두리) / `cluster`(테두리+군집) |
| 읽기 순서 | `--reading-order` | `xycut`(기본) / `off` |
| 머리글·바닥글 | `--include-header-footer` | 켜면 포함. 기본은 제거 |
| 이미지 처리 | `--image-output` | `off` / `embedded`(base64) / `external`(파일 참조) |
| 페이지 범위 | `--pages` | `1,3,5-7` |
| 암호 | `--password` | 문서 열기 암호 |
| 페이지 구분자 | `--markdown-page-separator` | `%page-number%` 치환 지원 |
| 줄바꿈 보존 | `--keep-line-breaks` | |
| OCR (hybrid 연결 시) | `--hybrid docling-fast` `--hybrid-url` | → [OCR](#ocr과-hybrid-서버) |
| 모든 페이지 보내기 | `--hybrid-mode` | `auto`(기본, 선별) / `full`(전 페이지) |
| 구조 트리 | `--use-struct-tree` | 태그드 PDF 의 읽기 순서. **hybrid 보다 우선** |

고정값: `--format markdown`, **`--keep-line-breaks`**(아래 참조), `--markdown-with-html`.

### `--quiet`는 쓰지 않는다 (7단계 실측)

원래 고정값에 `--quiet`가 있었다. 그것이 `java.util.logging`을 **통째로** 끄는 바람에 `WARNING`도 `SEVERE`도 사라졌다.

- `collectWarnings()`는 2단계부터 **한 줄도 받지 못하는 죽은 코드**였다. `WARNING: Detected background on page 1` 같은 실제 경고가 조용히 버려지고 있었다
- hybrid 서버가 꺼졌을 때 CLI가 내주는 **설치·구동 안내 6줄이 통째로 사라져**, 실패가 `변환 엔진이 1 로 끝났습니다`만 남았다

이제 `--quiet` 없이 받고 `javaLog()`가 레벨별로 가른다. `INFO`는 버리고(페이지 수·제목 등, 양만 많다), `WARNING`은 사용자 경고로, `SEVERE`는 실패 사유로 올린다. 한 기록이 여러 줄이므로 **이어지는 줄까지 모은다** — 안내가 반쪽이 되면 쓸모가 없다.

**`--space-ratio` 는 노출하지 않는다.** 한글 문제를 이걸로 고칠 수 있나 시험했더니 오히려 망가진다.

```
0.17 (기본)  이 문서는 Mark Extract의 PDF 어댑터를 … 섞여 있 으며
0.30         이 문서는MarkExtract의PDF어댑터를 … 섞여 있 으며
             MixedcontentwithEnglishwordslikeconversion,adapter,and markdown.
```

정당한 단어 사이 공백까지 사라지는데 원래 문제는 그대로다. 기본값을 유지하고 UI 에 내보내지 않는다.

### 한글 줄 잇기 — 2단계 실측, 이 단계의 핵심

기본 출력에서 한글 단어 가운데 공백이 끼어든다.

```
원문        … English가 섞여 있으며, 제목 계층과 …
기본 출력   … English가 섞여 있 으며, 제목 계층과 …
```

`--keep-line-breaks` 로 확인하니 PDF 줄바꿈이 정확히 `있` / `으며` 사이였다. **줄을 이을 때 공백을 넣는 동작이 영어에선 맞고 한글에선 틀리다.**

그래서 `--keep-line-breaks` 로 줄 경계를 살린 채 받아 **우리가 직접 잇는다** (`src/main/normalize.ts`).

| 줄 경계 양쪽 | 잇는 방법 |
|---|---|
| 둘 다 CJK (한글·한자·가나·전각) | 공백 없이 |
| 그 외 (영문, 숫자, 한글↔영문 경계) | 공백 하나 |

블록 줄(제목 `#`, 표 `|`, 인용 `>`, 코드 울타리, 목록 마커, 수평선)은 잇지 않는다. 빈 줄은 문단 경계라 남긴다.

### 알려진 제약 — 목록 마커

불릿 목록(`<ul><li>`)이 `-` 없는 문단으로 풀린다. opendataloader 의 목록 감지 한계이며 우리가 고칠 수 있는 것이 아니다. 변환 로그에 알리고, 목록 구조가 중요한 문서는 LLM 엔진을 쓰도록 안내한다.

### OCR과 hybrid 서버

opendataloader의 **로컬 Java 파이프라인에는 OCR이 없다.** OCR은 `--hybrid docling-fast`로 외부 Python 백엔드에 넘길 때만 동작한다.

- 서버는 exe에 포함하지 않는다. 사용자가 따로 설치·구동한다 (→ [04 설정 화면](04-ui-spec.md#설정-화면))
- 설정에 URL이 있고 연결 테스트를 통과했을 때만 인스펙터의 OCR 토글이 활성화된다
- `--hybrid-fallback`은 **어떤 경우에도 넘기지 않는다.** CLI 기본값이 이미 꺼짐이라 넘길 필요도 없다. 서버 오류를 조용히 Java 경로로 되돌리면 사용자가 OCR이 안 걸린 결과를 OCR 결과로 믿는다
- 서버 주소가 비어 있으면 OCR을 켜도 `--hybrid`를 붙이지 않는다. 붙이면 CLI가 자기 기본 주소로 붙다 실패하고, 사용자는 왜 안 되는지 모른다
- OCR을 켜면 **프로세스 제한 시간을 30분으로 올린다**(기본 10분). 스캔 수십 장이면 10분은 정상 동작을 실패로 만든다 — build.8에서 LLM 경로가 같은 이유로 물렸다. `--hybrid-timeout`은 백엔드 쪽 시간이라 건드리지 않는다(0 = 백엔드 기본값)

### 실측 (Docling Fast Server 1.0.0)

서버를 실제로 깔아(`pip install "opendataloader-pdf[hybrid]"`) 띄워서 확인했다.

| 확인한 것 | 결과 |
|---|---|
| 연결 테스트 엔드포인트 | `GET /health` → `200 {"status":"ok"}`, 13ms |
| Java CLI가 부르는 곳 | `POST /v1/convert/file` (우리는 부르지 않는다) |
| 서버 꺼짐 | exit 1 + `SEVERE: … Hybrid server is not available at <url>` 에 설치·구동 안내 동봉 |
| 서버 살아 있고 백엔드 실패 | exit 1 + `WARNING: Backend chunk failed …` → `SEVERE: Backend processing failed for N page(s) with fallback disabled` |
| `--use-struct-tree` + `--hybrid` (태그드 PDF) | exit 0, **서버 호출 없음**(POST 수 변화 없음). CLI가 직접 경고를 낸다 |

`--use-struct-tree`는 태그드 PDF에서 hybrid보다 **우선한다**. 둘 다 켜면 구조 트리가 이기고 hybrid는 호출되지 않으므로, 인스펙터에서 동시 선택 시 그 사실을 표시한다.

> **검증하지 못한 것: 실제 OCR 결과.** docling이 모델을 HuggingFace에서 받는데 개발 환경의 네트워크 정책이 그것을 막는다(`httpx.ProxyError: 403`). 서버까지 닿는 것과 실패를 읽는 것은 확인했고, 인식 품질은 사내 PC에서 확인해야 한다.

---

## DOCX / XLSX / XLS — kordoc

### 호출

```ts
import { parseDocx, parseXlsx, parseXls } from "kordoc"
const result = await parseDocx(buffer, { pages, password, onProgress, classifyTables })
// result.markdown, result.blocks, result.warnings, result.metadata
```

`parse()` 자동 판별 대신 **포맷별 함수를 직접 부른다.** 우리가 이미 매직 바이트로 포맷을 확정했고, 자동 판별이 HWP·PDF 경로로 흘러가는 것을 막기 위해서다 (결정 5로 HWP는 미지원이고 PDF는 opendataloader가 맡는다).

**줄 잇기(`joinWrappedLines`)를 쓰지 않는다 — 3단계 실측.** kordoc 출력에는 접힌 줄이 없다. 그런데 스프레드시트에서 연속한 두 줄은 서로 다른 셀이라, PDF 용 줄 잇기를 적용하면 별개 값이 한 줄로 뭉개진다.

```
시트가 둘 이상일 때 모두 나오는지 본다.      ← A1
English and 한국어 mixed.                    ← A2
  → 이으면: 시트가 둘 이상일 때 모두 나오는지 본다. English and 한국어 mixed.
```

그래서 `normalizeMarkdown`(공통 정리)과 `joinWrappedLines`(PDF 전용)를 나눠 두고 PDF 어댑터만 둘을 조합한다.

**오류 필드 모양**: kordoc 의 실패 결과는 사람이 읽을 메시지를 `error`(문자열)에, 분류를 `code` 에 따로 담는다. `error.code` 가 아니다.

### 설치와 패키징 — 3단계 실측

`.npmrc` 에 `omit=optional` 을 두는 방법은 **쓸 수 없다.** TypeScript 7 의 플랫폼 바이너리(`@typescript/typescript-linux-x64` 등)가 optionalDependencies 라 tsc 가 통째로 깨진다.

대신 **패키징 단계에서 걸러낸다.** kordoc 이 runtime dependency 라 그 의존성 트리가 asar 에 통째로 들어오는데, 우리가 쓰는 것은 DOCX·XLSX·XLS 경로뿐이다.

| 제외 | 이유 | 크기 |
|---|---|---|
| `pdfjs-dist`, `@hyzyla/pdfium` | kordoc 의 PDF 경로. PDF 는 opendataloader 몫 | 48MB |
| `@modelcontextprotocol/**`, `hono`, `@hono/**`, `jose`, `zod-to-json-schema` | kordoc 의 MCP 서버(`kordoc-mcp`). 라이브러리를 직접 부른다 | 약 7MB |
| `onnxruntime-node`, `sharp`, `@huggingface/**` | OCR·이미지 처리. 설치되지도 않지만 막아 둔다 | — |

**asar 75MB → 25MB.** 제외가 안전한지는 `--self-test` 가 패키징된 앱에서 다섯 형식을 모두 돌려 확인한다 — 어댑터가 실제로는 쓰고 있었다면 거기서 드러난다.

### 경고·오류 매핑

kordoc의 `ParseWarning[]`을 그대로 변환 로그에 싣고, 사용자에게 보여줄 것만 골라 경고 배지로 띄운다.

| kordoc `WarningCode` | UI 처리 |
|---|---|
| `SKIPPED_IMAGE`, `SKIPPED_OLE` | 경고 배지 "이미지 N개 건너뜀" |
| `TRUNCATED_TABLE` | 경고 배지 — 표가 잘렸으므로 눈에 띄어야 함 |
| `UNSUPPORTED_ELEMENT`, `MALFORMED_XML` | 로그에만 |
| `PARTIAL_PARSE` | 경고 배지 "일부만 추출됨" |
| `BROKEN_ZIP_RECOVERY`, `LENIENT_CFB_RECOVERY` | 로그에만 (복구 성공) |

`ErrorCode`는 실패 화면 문구와 버튼으로 매핑한다.

| kordoc `ErrorCode` | 문구 | 버튼 |
|---|---|---|
| `ENCRYPTED` | 열기 암호가 필요합니다 | 암호 입력 후 재시도 |
| `DRM_PROTECTED` | DRM으로 보호된 문서입니다 | (없음) — 앱이 풀 수 없음을 명시 |
| `CORRUPTED` | 파일이 손상되었습니다 | 그대로 재시도 |
| `UNSUPPORTED_FORMAT` | 지원하지 않는 형식입니다 | (없음) |
| `ZIP_BOMB`, `DECOMPRESSION_BOMB` | 비정상적으로 큰 압축 구조 | (없음) — 안전상 중단 |
| `OUTPUT_TOO_LARGE` | 결과가 너무 큽니다 | 페이지 범위 지정 후 재시도 |

---

## PPTX — 자체 구현

kordoc은 PPTX를 지원하지 않는다 (`FileType`에 없고 `presentationml` 문자열도 없다). markitdown(MIT, Microsoft)의 PPTX 변환 **규칙**을 TypeScript로 옮겨 어댑터를 만든다. markitdown은 Python `python-pptx` 기반이라 코드를 그대로 쓸 수 없고, Python 런타임 동봉은 단일 exe 취지와 충돌한다.

### 구현 방식

`jszip`으로 `.pptx`(ZIP)를 열고 `@xmldom/xmldom`으로 XML을 읽는다. 둘 다 kordoc이 이미 가져오는 의존성이라 추가 설치가 없다.

**도형은 `p:spTree` 의 직계 자식만 본다.** `getElementsByTagNameNS` 는 모든 자손을 훑으므로 그룹 안의 도형까지 중복으로 잡힌다. 구조는 `p:sld > p:cSld > p:spTree > p:sp` 다.

읽는 파트:
- `ppt/presentation.xml` — 슬라이드 순서 (`p:sldIdLst`)
- `ppt/slides/slideN.xml` — 도형
- `ppt/slides/_rels/slideN.xml.rels` — 이미지·차트 참조 해소
- `ppt/notesSlides/notesSlideN.xml` — 발표자 노트
- `ppt/charts/chartN.xml` — 차트 캐시 데이터

### 변환 규칙 (markitdown 동작 기준)

| 요소 | Markdown |
|---|---|
| 슬라이드 경계 | `<!-- Slide number: N -->` |
| 도형 정렬 | **제목 먼저**, 그 다음 위→아래·왼쪽→오른쪽 (`a:off` 의 `y`, `x`) |
| 제목 자리표시자 | `# {텍스트}` |
| 일반 텍스트 상자 | 문단 그대로 |
| 표 (`a:tbl`) | Markdown 표. 첫 행을 헤더로 |
| 이미지 | `![{대체텍스트}]({파일명})` — 대체텍스트는 `descr` → 도형 이름 순으로 채움 |
| 차트 | `### Chart: {제목}` + 계열을 열, 범주를 행으로 하는 표 |
| 그룹 도형 | 같은 규칙으로 재귀 |
| 처리 못 한 요소 | 건너뛰고 `UNSUPPORTED_ELEMENT` 경고 |

markitdown은 표를 HTML로 만든 뒤 Markdown으로 변환하지만, 우리는 **바로 Markdown 표를 만든다.** 중간 HTML 변환기를 들일 이유가 없다. 셀 안 줄바꿈은 `<br>`로, 파이프는 `\|`로 이스케이프한다.

**markitdown 과 다르게 한 것 둘 — 3단계 실측**

1. **제목을 위치와 무관하게 맨 앞으로 보낸다.** 자리표시자는 `a:off` 를 생략하고 슬라이드 레이아웃에서 위치를 물려받는 일이 흔하다. markitdown 은 python-pptx 가 상속을 풀어 준 값을 쓰지만 우리는 XML 만 읽으므로 알 수 없어, 제목이 표·본문 뒤로 밀렸다. 슬라이드 제목은 그 슬라이드의 머리이므로 먼저 내보내는 쪽이 맞다.
2. **문단을 빈 줄로 나눈다.** markitdown 은 텍스트 프레임의 문단을 줄바꿈으로만 잇는데, 마크다운에서는 그러면 한 덩어리로 렌더된다.

차트가 캐시 데이터를 갖고 있지 않거나 지원하지 않는 종류면 `[unsupported chart]`를 남기고 경고를 단다.

### 범위 (결정 24)

**다루는 것**: 슬라이드 텍스트, 표, 발표자 노트, 이미지 참조, 차트.

**다루지 않는 것** (경고만 남기고 건너뜀): SmartArt, 애니메이션, 슬라이드 마스터의 배경 텍스트, 삽입된 OLE 객체. 확장 여부는 실제 문서에서 필요성이 확인된 뒤에 정한다.

---

## 경계 조건

모든 어댑터에 공통으로 적용한다.

| 상황 | 처리 |
|---|---|
| 0바이트 파일 | 즉시 실패. `EMPTY_INPUT` |
| 파일 크기 상한 초과 | **500MB** (결정 21). 초과 시 변환 전 실패. 설정에서 변경 가능 |
| 파일이 다른 앱에 잠김 | 읽기 실패를 명시하고 "파일을 닫고 재시도" 안내 |
| 암호 문서 | 암호 입력 다이얼로그 → 재시도. 암호는 메모리에만 두고 저장하지 않는다 |
| 텍스트가 없는 PDF(스캔본) | 결과가 사실상 비면 감지해 "스캔 문서로 보입니다" 안내. hybrid 연결되어 있으면 'OCR 켜고 재시도', 아니면 설정 화면으로 보내는 링크 |
| 변환 결과가 빈 문자열 | 성공으로 처리하지 않는다. 실패로 두고 사유를 남긴다 |
| 확장자와 실제 내용 불일치 | 실제 내용을 따르고 로그에 기록 |

## 한글 인코딩

- 자식 프로세스의 출력은 **항상 UTF-8로 디코딩**한다. Windows 기본 코드페이지(949)를 타지 않도록 `-Dfile.encoding=UTF-8`을 JVM에 준다.
- 그럼에도 stdout 경유는 콘솔 설정의 영향을 받을 수 있어 **PDF는 파일 경유가 기본**이다 (위 참조).
- 출력 파일은 BOM 없는 UTF-8로 쓴다. 파일명에 한글·공백이 있어도 되도록 경로는 항상 인자 배열로 전달하고 셸을 거치지 않는다 (`shell: false`).


---

## Markdown 안의 HTML (build.8 실측 반영)

두 로컬 엔진 모두 GFM이 허용하는 HTML을 정당하게 내놓는다. 사용자가 Windows에서 본
`<table><tr><th>`와 `&lt;br&gt;`는 그 결과다.

| 엔진 | 언제 HTML을 내나 |
|---|---|
| kordoc | 병합 셀이나 복합 셀 내용이 있으면 `tableToMarkdown()`이 `tableToHtml()`로 빠진다 (`chunk-A2JDWBKG.js:609`). 파이프 경로에서도 셀 안 개행을 `<br>`로 바꾼다 |
| opendataloader | `MarkdownGenerator.getLineBreak()`이 **표 안에서는** `<br>`를 낸다. 같은 클래스가 `&` `<` `>`를 엔티티로 이스케이프한다 |

### opendataloader는 `--markdown-with-html`으로 받는다

이 플래그가 없으면 표를 파이프 표로 평탄화하는데, 실측해 보니 두 가지가 깨져 있었다.

```
병합 없이 평탄화     |1분기|목표일정|비고|
                    | |설계 확정|완료|      ← 걸쳐 있던 "1분기"가 사라진다
셀 안 파이프 미이스케이프  |특수문자|파이프 | 와 꺾쇠 …|   ← 행이 3칸으로 쪼개진다
```

HTML로 받으면 구조가 남고, 셀 안에서는 `|`를 이스케이프할 필요가 없다. 그리고 kordoc
출력과 **같은 모양**이 되어 변환기 하나로 처리된다.

### `html-in-markdown.ts`

```
<table>…</table>  →  GFM 파이프 표
&amp; &lt; &gt;    →  & < >
```

- **병합은 펼친다.** `rowspan`/`colspan`을 격자로 펴서 걸친 칸마다 같은 값을 넣는다.
  GFM에 병합이 없고, 빈 칸으로 두면 무엇에 속한 값인지 알 수 없어진다. 편 사실은
  `TABLE_MERGE_FLATTENED` 경고로 남긴다
- **셀 안 `<br>`는 유지한다.** GFM에서 셀 안 줄바꿈을 나타내는 관례이고 정보 손실이
  없다. 렌더러가 이것만 허용 목록으로 되살린다
- **셀 안 `|`는 `\|`로 이스케이프한다**
- **엔티티는 한 번만 푼다.** 두 번 돌리면 `&amp;lt;`가 `<`까지 풀려 원문에 없던
  태그가 생긴다
- **실패하면 그 표만 원본대로 둔다.** 표 하나 때문에 문서 전체를 잃지 않는다.
  렌더러가 `.rawtable`로 감싸 무슨 일이 있었는지 알린다
- 코드 울타리(` ``` `) 안은 건드리지 않는다

`normalize.ts`에 넣지 않은 이유는 `joinWrappedLines`를 PDF 전용으로 떼어냈던 것과
같다 — 적용 범위가 다르고, 한곳에 뭉치면 어느 포맷에 무엇이 걸리는지 알 수 없게 된다.

### kordoc 의 이스케이프를 떼어 낸다 (build.25 실측)

kordoc 의 `escapeGfm` 이 `*` `_` `~` `` ` `` 를 **본문 어디에 있든** 이스케이프한다.
그래서 Word 에서 `* 항목` 으로 시작한 줄이 `\* 항목` 으로 나왔다 — 원문에 없던
역슬래시가 사용자에게 보인다.

`office-kordoc.ts` 가 kordoc 결과를 받은 직후 그 역슬래시만 뗀다. 표의 `\|` 는
건드리지 않는다 — 그것은 `html-in-markdown.ts` 가 파이프 표를 위해 일부러 넣는다.

맞바꿈: 원문에 진짜로 `*강조*` 모양이 있으면 이제 뷰어에서 기울임으로 보인다.
원문 글자를 그대로 두는 쪽을 골랐다.

**opendataloader 는 이스케이프하지 않는다**(같은 자료를 두 엔진에 넣어 실측). 이
처리는 kordoc 경로에만 둔다.

### 암호·DRM 문서는 판별 단계에서 가른다 (build.25 실측)

사내 문서는 DRM 이 기본이라 이 경로가 흔한데, 그때까지는 매직 바이트 판별이
`unknown` 을 내고 화면에는 "HWP 계열은 지원하지 않습니다" 가 떴다. **틀린 안내다** —
사용자가 할 일은 DRM 을 푸는 것이다.

| 무엇을 보는가 | 판정 |
|---|---|
| OLE2 컨테이너 안에 `EncryptedPackage` · `EncryptionInfo` (UTF-16LE) | `protected` |
| 확장자가 `.docx`·`.xlsx`·`.pptx` 인데 컨테이너가 ZIP 이 아니라 OLE2 | `protected` |
| OLE2 인데 확장자가 `.xls` | `xls` (그대로) |
| 그 밖의 OLE2 (옛 `.doc`·`.ppt`, HWP 5.x) | `unknown` |

문구는 **"암호 또는 DRM 으로 보호된 문서로 보입니다. DRM 을 해제한 사본으로 다시
시도해 주세요."**, 코드는 `DRM_PROTECTED` — kordoc 이 쓰는 이름과 맞췄다.

벤더별 DRM 스트림 이름은 확인한 것이 없어 넣지 않았다. 확장자 조합이 그 자리를
메운다. **앱이 DRM 을 직접 푸는 것은 하지 않는다** — 솔루션마다 방식이 다르고
확인할 방법이 없다.

확장자까지 바꾸는 DRM 도구가 더 고약하다. 폴더를 훑을 때는 확장자만 보므로 `.dcm`
같은 이름이면 큐에 들어오지도 않는다. 그래서 `add()` 가 **건너뛴 파일 이름**을 함께
돌려주고 토스트가 그것을 적는다.

### 알려진 제약 — kordoc이 표 셀의 공백을 지운다

`sanitizeText`가 **30자 이하 + 3토큰 이상 + 한글 1글자 토큰 70% 이상**인 셀에서 공백을
전부 지운다. HWP 서식의 `성 명` → `성명` 같은 자간 늘림을 되돌리려는 규칙인데 평범한
문장도 걸린다 (`셀 하나에 세 줄` → `셀하나에세줄`).

**끄는 옵션이 없고 지워진 공백을 복원할 방법도 없다.** 우리가 손대지 않는다. 실제
한국어 문서에서 짧은 셀이 붙어 나오면 이것이 원인이다.
