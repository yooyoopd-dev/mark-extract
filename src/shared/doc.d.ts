/**
 * 문서와 큐의 공유 타입.
 *
 * 5단계부터 문서 목록은 main 이 들고 있다 (docs/design/01-architecture.md).
 * 렌더러는 이벤트로 받아 그리기만 한다.
 */
import type { DocOptions as ParseOptions, ParseResult } from "./parse";

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
