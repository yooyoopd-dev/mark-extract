/** preload 가 contextBridge 로 노출하는 표면. preload 와 렌더러가 함께 쓴다. */
import type { CliStatus, DocOptions, DocView, ExportResult, MdSaveOutcome, OcrStatus, Settings, WatchFolder } from "./doc";

export type { CliStatus, DocKind, DocOptions, DocStatus, DocView, ExportResult, MdSaveOutcome, OcrStatus, Settings, WatchFolder } from "./doc";
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
  cancel(id: string): Promise<void>;
  reconvert(id: string, options: DocOptions): Promise<void>;
  pickFiles(): Promise<AddResult>;
  /** 명령줄로 받은 문서. 탐색기에서 "연결 프로그램"으로 열 때 들어온다. */
  initialFiles(): Promise<string[]>;
  /** 큐가 바뀔 때마다 부른다. 구독을 끊는 함수를 돌려준다. */
  onChanged(handler: (docs: DocView[]) => void): () => void;

  /* Markdown 편집 (build.38) */
  newMd(): Promise<DocView>;
  /** 미리보기 HTML. 원문의 HTML 태그는 글자로 나온다 */
  renderMd(text: string): Promise<string>;
  /** 그 파일에 저장. `force` 면 바깥 수정을 무시하고 덮어쓴다 */
  saveMd(id: string, text: string, force?: boolean): Promise<MdSaveOutcome>;
  /** 다른 이름으로 저장. 취소하면 null */
  saveMdAs(id: string, text: string): Promise<MdSaveOutcome | null>;
  /** 저장 안 한 문서 수를 main 에 알린다. 창을 닫을 때 묻는 데 쓴다 */
  setUnsaved(count: number): Promise<void>;

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

  /* OCR 서버 — 앱이 띄우고 관리한다 (build.37) */
  ocrStatus(): Promise<OcrStatus>;
  /** 시작만 건다. 준비되는 과정은 onOcrChanged 로 온다 */
  startOcrServer(): Promise<OcrStatus>;
  /** 앱이 띄운 서버만 끈다 */
  stopOcrServer(): Promise<OcrStatus>;
  /** 설치·직접 구동 명령 (복사용) */
  ocrCommands(): Promise<{ install: string; run: string }>;
  onOcrChanged(handler: (status: OcrStatus) => void): () => void;

  /* 창 — 프레임이 없어 캡션 버튼을 우리가 그린다 */
  window(action: WindowAction): Promise<void>;
}

declare global {
  interface Window {
    readonly markExtract: MarkExtractApi;
  }
}
