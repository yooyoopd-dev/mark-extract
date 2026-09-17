/**
 * 문서와 큐의 공유 타입.
 *
 * 5단계부터 문서 목록은 main 이 들고 있다 (docs/design/01-architecture.md).
 * 렌더러는 이벤트로 받아 그리기만 한다.
 */
import type { DocOptions as ParseOptions, InputMode, ParseResult, Provider } from "./parse";

export type DocStatus = "queued" | "run" | "done" | "failed";
export type DocKind = "pdf" | "docx" | "xlsx" | "xls" | "pptx";

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
  readonly star: boolean;
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
  imageOutput: "off" | "embedded" | "external";
  /** LLM 변환 1건의 제한 시간(분). 로컬 엔진은 10분 고정 */
  llmTimeoutMin: number;
  /** LLM 출력 언어 */
  language: "ko" | "en" | "keep";
  /** 이보다 큰 파일은 큐에 넣지 않는다 (MB). 결정 21 */
  maxFileSizeMb: number;
  /** Ollama 루프백 조회 주소. 본문 생성은 CLI 가 한다 (결정 15) */
  ollamaUrl: string;
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
