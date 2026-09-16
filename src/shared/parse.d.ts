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

/** 인스펙터에서 온 문서별 옵션. 지금은 PDF 몫만 있다. */
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
}

export interface ParseRequest {
  readonly filePath: string;
  readonly options?: DocOptions;
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
