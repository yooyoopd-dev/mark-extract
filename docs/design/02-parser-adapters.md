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
| OCR (hybrid 연결 시) | `--hybrid docling-fast` `--hybrid-url` `--hybrid-timeout` | → [OCR](#ocr과-hybrid-서버) |

고정값: `--format markdown`, `--quiet`(로그는 stderr로), **`--keep-line-breaks`**(아래 참조).

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
- `--hybrid-fallback`은 기본 끔. 서버 오류를 조용히 Java 경로로 되돌리면 사용자가 OCR이 안 걸린 걸 모른다. 대신 실패로 처리하고 '그대로 재시도' 버튼을 준다
- `--use-struct-tree`는 태그드 PDF에서 hybrid보다 **우선한다**. 둘 다 켜면 구조 트리가 이기고 hybrid는 호출되지 않으므로, UI에서 동시 선택 시 그 사실을 표시한다

---

## DOCX / XLSX / XLS — kordoc

### 호출

```ts
import { parseDocx, parseXlsx, parseXls } from "kordoc"
const result = await parseDocx(buffer, { pages, password, onProgress, classifyTables })
// result.markdown, result.blocks, result.warnings, result.metadata
```

`parse()` 자동 판별 대신 **포맷별 함수를 직접 부른다.** 우리가 이미 매직 바이트로 포맷을 확정했고, 자동 판별이 HWP·PDF 경로로 흘러가는 것을 막기 위해서다 (결정 5로 HWP는 미지원이고 PDF는 opendataloader가 맡는다).

### 설치

`npm install kordoc --omit=optional`. optional 의존성(`onnxruntime-node`, `sharp`, `pdfjs-dist`, `@hyzyla/pdfium`, `@huggingface/transformers`)은 OCR·PDF·렌더링용이며 **우리가 쓰는 OOXML 경로에는 불필요**하다. 빼면 네이티브 바이너리가 사라져 Electron 재빌드·서명 문제도 없어진다. 남는 의존성은 `jszip`, `cfb`, `@xmldom/xmldom`, `markdown-it`, `commander`, `zod` — 전부 순수 JS다.

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
| 도형 정렬 | 위→아래, 같은 높이면 왼쪽→오른쪽 (`a:off` 의 `y`, `x`) |
| 제목 자리표시자 | `# {텍스트}` |
| 일반 텍스트 상자 | 문단 그대로 |
| 표 (`a:tbl`) | Markdown 표. 첫 행을 헤더로 |
| 이미지 | `![{대체텍스트}]({파일명})` — 대체텍스트는 `descr` → 도형 이름 순으로 채움 |
| 차트 | `### Chart: {제목}` + 계열을 열, 범주를 행으로 하는 표 |
| 그룹 도형 | 같은 규칙으로 재귀 |
| 처리 못 한 요소 | 건너뛰고 `UNSUPPORTED_ELEMENT` 경고 |

markitdown은 표를 HTML로 만든 뒤 Markdown으로 변환하지만, 우리는 **바로 Markdown 표를 만든다.** 중간 HTML 변환기를 들일 이유가 없다. 셀 안 줄바꿈은 `<br>`로, 파이프는 `\|`로 이스케이프한다.

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
