/**
 * 문서와 큐의 공유 타입.
 *
 * 5단계부터 문서 목록은 main 이 들고 있다 (docs/design/01-architecture.md).
 * 렌더러는 이벤트로 받아 그리기만 한다.
 */
import type { DocOptions as ParseOptions, InputMode, ParseResult, Provider } from "./parse";

export type DocStatus = "queued" | "run" | "done" | "failed";
export type DocKind = "pdf" | "docx" | "xlsx" | "xls" | "pptx" | "html" | "eml";

/**
 * 인스펙터에서 바꾸는 문서별 추출 옵션.
 *
 * 어댑터 옵션에서 암호만 뺀 것이다. DocView 는 렌더러로 그대로 나가는 값이라
 * 암호가 섞이면 안 된다 (결정 22 — 암호는 변환 1건 동안 메모리에만 둔다).
 */
export type DocOptions = Omit<ParseOptions, "password">;

export interface DocView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly kind: DocKind;
  readonly size: number;
  readonly status: DocStatus;
  readonly addedAt: number;
  readonly options: DocOptions;
  /** 변환 결과. 마크다운 본문은 크므로 여기 싣지 않는다 — doc:markdown 으로 따로 받는다. */
  readonly result: Omit<ParseResult, "markdown"> | null;
  /** 목록 카드에 보일 미리보기 */
  readonly snippet: string;

  /**
   * 변환 진행률 0~100. 총량을 아는 어댑터만 채운다 — LLM 은 얼마나 나올지 알 수
   * 없으므로 퍼센트를 지어내지 않고 받은 글자 수(chars)만 올린다.
   */
  readonly progress?: number;
  /** 변환을 시작한 시각. 화면이 경과 시간을 센다. */
  readonly startedAt?: number;
  /** 지금까지 받은 본문 글자 수. 총량을 모르는 엔진의 진행 표시. */
  readonly chars?: number;
}

export interface WatchFolder {
  readonly path: string;
  readonly addedAt: number;
}

export interface Settings {
  /** 동시에 몇 건까지 변환할지. 기본 1 — JVM 콜드 스타트 때문에 병렬 이득이 작다. */
  concurrency: number;
  /** 내보내기 기본 경로 */
  outputDir: string | null;
  /** 내보낼 때 YAML 프론트매터를 붙일지 */
  frontmatter: boolean;
  theme: "system" | "light" | "dark";
  watch: WatchFolder[];

  /* ── 새 문서에 심을 기본 옵션 (6b) ─────────────────── */
  //
  // 인스펙터에서 문서마다 덮어쓴다. 여기 값은 큐에 새로 들어오는 문서의 출발점일
  // 뿐이고, 이미 들어와 있는 문서는 바꾸지 않는다 — 바꾸면 사용자가 손댄 설정이
  // 조용히 날아간다.

  /** 기본 엔진. 로컬이 기본이어야 한다 — 재현 가능한 결과가 기본이다 */
  defaultEngine: "local" | "llm";
  provider: Provider;
  /** 빈 문자열이면 CLI 기본값 */
  model: string;
  inputMode: InputMode;
  imageOutput: "note" | "off";
  /** LLM 변환 1건의 제한 시간(분) */
  llmTimeoutMin: number;
  /**
   * 로컬 변환 1건의 제한 시간(분).
   *
   * 10분 고정이었는데 OCR 을 켠 스캔 문서가 그 안에 끝나지 않아 **정상 동작이
   * 실패로 끊겼다**(build.28 실측). 기본을 30분으로 올리고 설정에서 늘릴 수 있게
   * 했다. OCR 을 켜면 이 값이 30분보다 작아도 30분은 준다.
   */
  localTimeoutMin: number;
  /** LLM 출력 언어 */
  language: "ko" | "en" | "keep";
  /** 이보다 큰 파일은 큐에 넣지 않는다 (MB). 결정 21 */
  maxFileSizeMb: number;
  /** Ollama 루프백 조회 주소. 본문 생성은 CLI 가 한다 (결정 15) */
  ollamaUrl: string;
  /**
   * hybrid OCR 서버 주소 (결정 6).
   *
   * 비어 있으면 기본 주소(`http://127.0.0.1:5002`)를 쓴다 (build.37 — 전에는 "OCR 을
   * 쓰지 않음" 이었다). 루프백이면 앱이 서버를 띄우고, 원격이면 연결만 확인한다.
   * 원격이면 **PDF 원본이 그 서버로 나간다** — 설정 화면이 그 사실을 알린다.
   */
  hybridUrl: string;
  /**
   * 앱을 켤 때 OCR 서버도 켤지 (build.37). 기본 끔 — 서버가 메모리를 많이 쓴다.
   *
   * build.25 의 `ocrByDefault`(새 PDF 에 OCR 켜 두기)를 대신한다. 그 값은 화면이
   * "OCR 꺼짐" 으로 그리는 문서를 실제로는 OCR 서버로 보내는 어긋남의 뿌리였다.
   */
  ocrAutoStart: boolean;
}

/**
 * OCR 서버 상태 (build.37). main 의 `ocr-server.ts` 가 들고 있고 바뀔 때마다 방송한다.
 *
 * 판정은 `/health` 하나로 한다. 서버 로그의 ERROR 줄은 보지 않는다 — docling 이 시작할
 * 때 무해한 ERROR 를 찍고(사내 PC 실측), 그것이 실패로 읽혔다.
 */
export interface OcrStatus {
  readonly phase: "off" | "starting" | "on" | "failed";
  /** 화면에 그대로 띄울 한 줄 */
  readonly detail: string;
  /** 지금 쓰는 서버 주소 */
  readonly url: string;
  /** 앱이 띄운 서버인가. false 면 앱 밖에서 떠 있던 서버거나 원격 서버다 */
  readonly managed: boolean;
  /** 시작 중이면 시작 시각 */
  readonly since?: number;
  /** 서버가 마지막으로 찍은 줄. 시작이 오래 걸릴 때 멈춘 게 아니라는 표시가 된다 */
  readonly lastLine?: string;
  /** 실패면 서버 로그의 꼬리 */
  readonly tail?: string;
  /** 실행 파일을 찾지 못했다 — 설치 명령을 보여 준다 */
  readonly missing?: boolean;
}

export interface ExportRequest {
  /** 문서 id 목록. 비면 완료된 전부. */
  readonly ids: readonly string[];
  readonly outputDir: string;
  readonly frontmatter: boolean;
}

export interface ExportResult {
  readonly written: number;
  readonly failed: number;
  readonly outputDir: string;
}


/** 설정 화면의 CLI 탐지 결과. 사내망 PC 는 화면에서 읽고 옮겨 적어야 한다. */
export interface CliStatus {
  readonly provider: Provider;
  readonly label: string;
  readonly found: boolean;
  readonly command: string | null;
  /**
   * 찾은 것을 실제로 띄워 보았더니 돌았는가.
   *
   * 찾은 것과 도는 것은 다른 사실이다. build.10 은 `gemini.cmd` 를 찾아 놓고
   * 실행하지 못했다 — 파일 존재만 보던 탐지가 그것을 통과시켰다.
   */
  readonly runnable: boolean;
  /** --version 이 내놓은 첫 줄, 또는 실행하지 못한 사유. */
  readonly detail: string;
  /** 어디를 어떻게 찾았는지. 실패했을 때 그대로 띄운다. */
  readonly report: readonly string[];
}
