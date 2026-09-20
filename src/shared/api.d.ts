/** preload 가 contextBridge 로 노출하는 표면. preload 와 렌더러가 함께 쓴다. */
import type { CliStatus, DocOptions, DocView, ExportResult, Settings, WatchFolder } from "./doc";

export type { CliStatus, DocKind, DocOptions, DocStatus, DocView, ExportResult, Settings, WatchFolder } from "./doc";
export type { ParseResult } from "./parse";

export type WindowAction = "minimize" | "maximize" | "close";

export interface AddResult {
  readonly added: number;
  readonly skipped: number;
  /** 크기 상한을 넘어 건너뛴 파일. 조용히 사라지면 사용자가 이유를 알 수 없다. */
  readonly oversized: ReadonlyArray<{ name: string; mb: number }>;
  /** 확장자가 지원 목록에 없어 건너뛴 파일 이름 (DRM 도구가 확장자를 바꾼 경우 포함). */
  readonly unsupported: ReadonlyArray<string>;
}

export interface MarkExtractApi {
  readonly version: string;

  /**
   * 드롭된 File 에서 실제 경로를 얻는다.
   *
   * sandbox: true 인 렌더러에는 File.path 가 없다. webUtils 는 preload 에서만
   * 쓸 수 있어 여기를 통해야 한다.
   */
  getFilePath(file: File): string;

  /* 문서 */
  list(): Promise<DocView[]>;
  markdown(id: string): Promise<string>;
  /** 파일이든 폴더든. 폴더는 안을 훑어 지원 형식만 넣는다. */
  add(paths: readonly string[]): Promise<AddResult>;
  remove(id: string): Promise<void>;
  star(id: string, value: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  reconvert(id: string, options: DocOptions): Promise<void>;
  pickFiles(): Promise<AddResult>;
  /** 명령줄로 받은 문서. 탐색기에서 "연결 프로그램"으로 열 때 들어온다. */
  initialFiles(): Promise<string[]>;
  /** 큐가 바뀔 때마다 부른다. 구독을 끊는 함수를 돌려준다. */
  onChanged(handler: (docs: DocView[]) => void): () => void;

  /* 내보내기 */
  pickOutputDir(): Promise<string | null>;
  exportMarkdown(request: {
    ids: readonly string[];
    outputDir: string;
    frontmatter: boolean;
  }): Promise<ExportResult>;
  reveal(path: string): Promise<string>;

  /* 감시 폴더 */
  addWatch(): Promise<WatchFolder[]>;
  removeWatch(path: string): Promise<WatchFolder[]>;

  /* 설정 */
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  /* LLM 진단 (설정 화면) */
  detectCli(): Promise<CliStatus[]>;
  /** 프롬프트 전문. 실제로 쓰이는 것과 같은 함수에서 만든다 (결정 25) */
  promptText(): Promise<string>;

  /** 자체 점검을 돌리고 결과 전문을 돌려준다. 수십 초 걸릴 수 있다. */
  selfTest(): Promise<string>;
  ollamaModels(): Promise<{ ok: boolean; models: string[]; detail: string }>;
  /** hybrid OCR 서버가 살아 있는지 (7단계). url 을 주면 그 주소로, 없으면 설정값으로. */
  testHybrid(url?: string): Promise<{ ok: boolean; detail: string; ms: number }>;

  /* 창 — 프레임이 없어 캡션 버튼을 우리가 그린다 */
  window(action: WindowAction): Promise<void>;
}

declare global {
  interface Window {
    readonly markExtract: MarkExtractApi;
  }
}
