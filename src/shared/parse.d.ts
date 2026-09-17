/**
 * 파서 어댑터 공통 계약 (docs/design/02-parser-adapters.md).
 *
 * 타입 선언뿐이라 .d.ts 로 둔다 — main·preload·renderer 가 모두 import type 으로
 * 쓰되 어느 쪽에서도 JS 가 나오지 않는다.
 *
 * 어댑터 3종(PDF, Office, PPTX)이 모두 이 모양을 지킨다. 호출자(큐)는 어느
 * 어댑터인지 알 필요가 없다.
 */

/** 변환은 성공했으나 알려야 할 것. 표가 잘렸다거나 이미지를 건너뛰었다거나. */
export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly page?: number;
}

/** 변환 로그 탭에 그대로 실린다. 사내망에서는 화면이 유일한 진단 수단이다. */
export interface LogEntry {
  readonly label: string;
  readonly value: string;
}

/** 실패 화면의 버튼이 된다. 사유만 있고 행동이 없는 실패는 만들지 않는다. */
export type RetryAction =
  | "retry-plain"
  | "retry-with-ocr"
  | "retry-mode-b"
  | "retry-with-password";

export interface ParseError {
  readonly code: string;
  readonly message: string;
  readonly actions: readonly RetryAction[];
}

/** LLM 을 어떤 CLI 로 띄울지 (결정 9). */
export type Provider = "claude" | "gemini" | "codex" | "ollama";

/**
 * LLM 에 무엇을 건넬지 (결정 10).
 *
 *   A — 파일 경로를 주고 CLI 가 자기 도구로 읽게 한다
 *   B — 로컬 파서로 Markdown 을 뽑아 그 텍스트를 넘겨 다듬게 한다
 */
export type InputMode = "A" | "B";

/** 인스펙터에서 온 문서별 옵션. */
export interface DocOptions {
  /** 표 감지 방식. default = 테두리 기반, cluster = 테두리 + 군집 */
  readonly tableMethod?: "default" | "cluster";
  /** 읽기 순서 알고리즘 */
  readonly readingOrder?: "xycut" | "off";
  /** 켜면 머리글·바닥글을 남긴다. 기본은 제거 */
  readonly includeHeaderFooter?: boolean;
  /** off = 이미지 없음, embedded = base64, external = 파일 참조 */
  readonly imageOutput?: "off" | "embedded" | "external";
  /** "1,3,5-7" */
  readonly pages?: string;
  /** 문서 열기 암호. 메모리에만 두고 저장하지 않는다 */
  readonly password?: string;

  /* ── OCR · hybrid 서버 (7단계) ────────────────────── */
  //
  // opendataloader 의 로컬 Java 파이프라인에는 OCR 이 없다. 외부 Python 서버에
  // 넘길 때만 동작한다 (결정 6).

  /** 켜면 --hybrid docling-fast. 설정의 서버 주소가 같이 넘어간다 */
  readonly ocr?: boolean;
  /**
   * --hybrid-mode full. 기본 auto 는 서버에 보낼 페이지를 골라 내는데, 그 판정이
   * 스캔 페이지를 놓쳤을 때 손으로 전수를 보내는 길이다.
   */
  readonly hybridFullPages?: boolean;
  /**
   * --use-struct-tree. 태그드 PDF 의 구조 트리로 읽기 순서를 잡는다.
   *
   * **hybrid 보다 우선한다.** 둘 다 켜고 태그드 PDF 를 넣으면 CLI 가 구조 트리를
   * 쓰고 서버를 부르지 않는다 (실측 확인).
   */
  readonly useStructTree?: boolean;

  /* ── LLM 엔진 (6단계) ─────────────────────────────── */

  /** 기본은 로컬. LLM 은 같은 문서라도 결과가 달라질 수 있다 */
  readonly engine?: "local" | "llm";
  readonly provider?: Provider;
  /**
   * 빈 값이면 CLI 기본값을 쓴다.
   *
   * 모델 목록을 앱에 박지 않는다 — CLI 버전마다 받는 이름이 다르고 우리가 고정하면
   * 금방 낡는다. Ollama 만 설정 화면이 /api/tags 로 채운다 (6b).
   */
  readonly model?: string;
  readonly inputMode?: InputMode;
  /**
   * 변환 1건의 제한 시간. 비우면 엔진별 기본값 — 로컬 10분, LLM 30분.
   *
   * LLM 을 길게 잡는 이유는 로컬 모델 때문이다. 14B 모델이 CPU 에서 긴 문서를 다시
   * 쓰면 수십 분이 정상이다 (build.8 실측 보고).
   */
  readonly timeoutMs?: number;
}

export interface ParseRequest {
  readonly filePath: string;
  readonly options?: DocOptions;
  /**
   * hybrid OCR 서버 주소. 설정에서 오고 문서별 옵션이 아니다 (7단계).
   *
   * 비어 있으면 OCR 을 켜도 인자를 붙이지 않는다 — 기본 주소로 붙다 실패하면
   * 사용자는 OCR 을 켰는데 왜 안 되는지 모른다.
   */
  readonly hybridUrl?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (current: number, total: number) => void;
}

export interface ParseResult {
  readonly ok: boolean;
  /** ok === false 이면 "" */
  readonly markdown: string;
  readonly warnings: readonly Warning[];
  readonly log: readonly LogEntry[];
  readonly meta: {
    readonly pages?: number;
    readonly engine: string;
    readonly elapsedMs: number;
  };
  readonly error?: ParseError;
}
