# 01 — 아키텍처

## 프로세스 모델

Electron 3계층. 렌더러는 Node에 접근하지 못하고, 파일 시스템과 서브프로세스는 전부 main이 다룬다.

```
┌─ main ──────────────────────────────────────────────┐
│  윈도우 · 설정 저장 · 변환 큐 · 감시 폴더            │
│  parsers/  ─ java(JAR) 서브프로세스, kordoc 호출     │
│  llm/      ─ claude/gemini/codex/ollama 서브프로세스 │
└──────────────────────┬──────────────────────────────┘
                       │ contextBridge (좁은 IPC 표면)
┌─ preload ────────────┴──────────────────────────────┐
│  화이트리스트된 채널만 노출. 임의 IPC 전달 금지      │
└──────────────────────┬──────────────────────────────┘
┌─ renderer ───────────┴──────────────────────────────┐
│  design/index.html 이식. Node 접근 없음              │
│  파일은 경로 문자열로만 다루고 직접 읽지 않는다      │
└─────────────────────────────────────────────────────┘
```

**보안 설정 (고정)**: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. 렌더러에서 원격 콘텐츠를 로드하지 않는다.

**IPC 표면**: 채널을 다음으로 한정한다. 와일드카드 전달자를 두지 않는다.

| 채널 | 방향 | 용도 |
|---|---|---|
| `doc:add` / `doc:remove` / `doc:reconvert` | R→M | 큐 조작 |
| `doc:progress` / `doc:done` / `doc:failed` | M→R | 상태 통지 |
| `doc:markdown` | R→M | 변환 결과 조회 |
| `export:markdown` | R→M | 파일 저장 |
| `settings:get` / `settings:set` | R↔M | 설정 |
| `diag:cli` / `diag:hybrid` | R→M | CLI·서버 진단 |
| `watch:add` / `watch:remove` / `watch:event` | R↔M | 감시 폴더 |

## 변환 파이프라인

```
큐 등록 → 포맷 감지 → 엔진 선택 → 어댑터 실행 → 마크다운 정규화 → 저장·표시
```

**포맷 감지**: 확장자가 아니라 **매직 바이트**로 판별한다. ZIP 컨테이너(`PK\x03\x04`)면 내부 엔트리로 OOXML 종류를 구분하고(`word/`, `xl/`, `ppt/`), OLE2(`\xD0\xCF\x11\xE0`)면 XLS, `%PDF-`면 PDF. 확장자와 실제 내용이 다르면 실제 내용을 따르고 변환 로그에 남긴다.

**엔진 선택**: 문서마다 `local` 또는 `llm`. 기본값은 설정에서, 개별 문서는 인스펙터에서 바꾼다. `llm`을 고르면 모드 A/B가 함께 결정된다 (→ [03](03-llm-engine.md)).

**마크다운 정규화** (어댑터 공통 후처리):
- 줄 끝을 `\n`으로 통일, 파일 끝에 개행 1개
- 연속 빈 줄 3개 이상 → 2개
- LLM 응답이 전체를 ` ```markdown ` 펜스로 감싼 경우 벗겨냄
- 앞뒤 공백 제거
- YAML 프론트매터는 설정에 따라 부착 (기본 켬): `title`, `source`, `pages`, `engine`, `converted_at`

## 동시성과 수명

- **작업 큐**: 문서 단위. 기본 동시 실행 **1**. JVM 콜드 스타트가 문서당 수백 ms~수 초이고 LLM CLI는 레이트·컨텍스트 제약이 있어 병렬화 이득이 작다. 설정에서 최대 4까지 올릴 수 있다.
- **취소**: 모든 어댑터는 `AbortSignal`을 받는다. 취소 시 자식 프로세스를 kill하고 임시 디렉터리를 지운다.
- **타임아웃**: 로컬 파서 기본 10분, LLM 기본 10분. 문서가 클수록 늘어나므로 설정 가능.
- **임시 파일**: 변환 1건마다 전용 임시 디렉터리를 만들고, 성공·실패·취소 **어느 경로로 끝나든** 지운다. 원본 문서 옆에는 아무것도 쓰지 않는다.

## 오프라인 전제

앱 자체는 네트워크 호출을 하지 않는다. 자동 업데이트 확인, 원격 텔레메트리, 원격 폰트·CDN 모두 없다. 외부로 나가는 통신은 다음 둘뿐이며, 각각 사용자가 켜야 하고 UI에 그 사실이 표시된다.

1. **hybrid OCR 서버** — 사용자가 URL을 입력했을 때만
2. **LLM CLI** — 사용자가 LLM 엔진을 선택했을 때만. CLI 자체가 하는 통신이며 앱이 직접 호출하지 않는다

Ollama의 `localhost:11434` 조회는 루프백이므로 외부 통신이 아니다 (결정 15).

## 디렉터리 구조

```
src/
  main/
    index.ts              앱 부트스트랩, 윈도우
    ipc.ts                채널 등록
    queue.ts              변환 큐, 동시성, 취소
    settings.ts           설정 영속화
    watch.ts              감시 폴더
    detect-format.ts      매직 바이트 판별
    normalize.ts          마크다운 후처리
    parsers/
      index.ts            어댑터 레지스트리 + 공통 계약
      pdf-opendataloader.ts
      office-kordoc.ts
      pptx.ts
    llm/
      cli-resolver.ts     실행 파일 탐색·캐시
      sandbox.ts          모드 A 임시 폴더 격리
      transports/
        claude.ts  gemini.ts  codex.ts  ollama.ts
  preload/
    index.ts
  renderer/
    index.html            design/index.html에서 이식
    styles/tokens.css     디자인 토큰 (04 참조)
    styles/*.css
    views/                sidebar · list · viewer · inspector · settings
    i18n/ko.json  i18n/en.json
resources/
  jre/                    jlink 산출물
  lib/opendataloader-pdf-cli.jar
```

## 실패 처리 원칙

- 어댑터는 예외를 던지지 않고 **결과 객체**로 실패를 반환한다. 큐가 한 문서의 실패로 멈추지 않는다.
- 실패 사유는 항상 **사용자가 할 수 있는 행동**과 함께 제시한다. "변환 실패"만 띄우지 않는다.
- 자식 프로세스의 stderr는 버리지 않고 변환 로그 탭에 그대로 보존한다. 사내망에서는 로그 파일을 반출할 수 없어 화면이 유일한 진단 수단이다.
