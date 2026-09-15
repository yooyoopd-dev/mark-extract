# Mark Extract — 설계 문서

문서를 넣으면 **Markdown만** 내놓는 Windows 단일 실행 데스크톱 앱.

사내망·오프라인 환경을 우선 전제로 한다. 앱 자체는 어떤 네트워크 호출도 하지 않으며, 외부와 통신하는 경로는 사용자가 명시적으로 켠 두 가지(hybrid OCR 서버, LLM CLI)뿐이다.

## 문서 구성

| 문서 | 내용 |
|---|---|
| [01-architecture.md](01-architecture.md) | 프로세스 모델, 모듈 경계, 변환 파이프라인, 디렉터리 구조 |
| [02-parser-adapters.md](02-parser-adapters.md) | 파서 3종의 계약, CLI 플래그 매핑, 경계 조건 |
| [03-llm-engine.md](03-llm-engine.md) | LLM CLI 서브프로세스 계층, 입력 모드 A/B, 프로바이더 4종 |
| [04-ui-spec.md](04-ui-spec.md) | 디자인 토큰, 화면·상태, 디자인 대비 변경점, 설정 화면 |
| [05-packaging.md](05-packaging.md) | Electron portable 빌드, JRE 동봉, 용량 |
| [06-roadmap.md](06-roadmap.md) | 8단계 구현 순서와 단계별 검증 기준, 미결 사항 |
| [ATTRIBUTION.md](ATTRIBUTION.md) | 차용 프로젝트 출처·라이선스 |

시각적 계약은 [`../../design/`](../../design/)에 있다.

## 지원 범위

### 지원하는 것

| 포맷 | 엔진 | 근거 |
|---|---|---|
| PDF | opendataloader-pdf (동봉 JAR) | 레이아웃 분석 기반이라 제목 계층·표·읽기 순서가 살아남음 |
| DOCX | kordoc `parseDocx` | |
| XLSX | kordoc `parseXlsx` | |
| XLS | kordoc `parseXls` | Excel 97-2003 |
| PPTX | 자체 구현 (markitdown 규칙 포팅) | kordoc이 PPTX를 지원하지 않음 — 아래 참조 |

출력은 **Markdown 하나뿐**이다. JSON·HTML·태그드 PDF는 내지 않는다.

### 지원하지 않는 것

- **HWP / HWPX / HWPML / HWP3** — kordoc이 지원하지만 요구사항에서 제외
- Markdown 외 출력 형식
- 문서 편집, 클라우드 동기화, 문서 생성(역변환)
- 이미지 단독 파일(PNG/JPG) 변환

## 확정된 설계 결정

번호는 다른 문서에서 "결정 N"으로 참조한다.

| # | 항목 | 결정 |
|---|---|---|
| 1 | 셸·패키징 | Electron + electron-builder `portable` → .exe 1개 |
| 2 | PDF | opendataloader-pdf, 경량 JRE와 JAR을 앱에 동봉 |
| 3 | DOCX/XLSX/XLS | kordoc (`--omit=optional`, 순수 JS 경로만) |
| 4 | PPTX | markitdown의 변환 규칙을 TypeScript로 포팅 |
| 5 | HWP/HWPX | 미지원 |
| 6 | OCR | opendataloader hybrid 서버 연동 옵션. exe에 미포함, 설정 화면에서 설치·구동 안내 |
| 7 | AI 범위 | 문서 단위로 로컬 엔진 / LLM 엔진 선택 |
| 8 | LLM 구동 | API 아님. CLI 서브프로세스 |
| 9 | LLM 프로바이더 | `claude` / `gemini` / `codex` / `ollama` |
| 10 | LLM 입력 모드 | 설정에서 A(파일 경로 전달) / B(로컬 파싱 → 재가공) 선택 |
| 11 | 뷰어 3번째 탭 | '추출 필드' → '변환 로그' |
| 12 | 출력 | Markdown만 |
| 13 | 언어 | 한국어·영어 i18n |
| 14 | llm-co-wiki 차용 | **사실 정보만 인용, 코드 복사 없음** — 근거는 [ATTRIBUTION.md](ATTRIBUTION.md) |
| 15 | Ollama 연결 | 본문 생성은 `ollama run` CLI, 모델 목록·컨텍스트 조회만 `localhost:11434` |
| 16 | 모드 A 파일 접근 | 임시 폴더 격리 + 읽기 전용 도구만 |
| 17 | 모드 A 포맷 미지원 | 자동 폴백 없음. 실패 처리 후 사용자가 '모드 B로 재시도' 선택 |

## 설계가 해결한 충돌 3건

차용 대상과 디자인 사이에 실제로 존재했던 불일치다.

1. **디자인은 PPTX를 전제하지만 kordoc은 PPTX를 파싱하지 못한다.**
   `kordoc@4.14.0`의 `FileType`에 `pptx`가 없고 패키지 전체에 `presentationml` 문자열도 없다.
   → markitdown(MIT)의 PPTX 변환 규칙을 TypeScript로 포팅해 자체 어댑터를 만든다 (결정 4).

2. **디자인에 OCR 토글이 있지만 opendataloader 로컬 파이프라인에는 OCR이 없다.**
   OCR은 `--hybrid docling-fast` 모드에서만 동작하고, 그 모드는 별도 Python 서버를 요구한다.
   → 단일 exe에 포함하지 않는다. 설정 화면에서 서버 설치·구동을 안내하고 `--hybrid-url`로 연결하며, 서버가 연결되었을 때만 OCR 토글을 활성화한다 (결정 6).

3. **"단일 실행 파일"인데 두 파서가 서로 다른 런타임을 요구한다.**
   kordoc은 Node, opendataloader는 Java 11+를 요구하고 npm 패키지는 JRE를 동봉하지 않는다.
   → Electron이 Node를 제공하고, jlink로 만든 경량 JRE를 앱에 동봉해 자식 프로세스 PATH 앞에 주입한다 (결정 1·2).
