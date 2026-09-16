/** preload 가 contextBridge 로 노출하는 표면. preload 와 렌더러가 함께 쓴다. */
import type { ParseResult } from "./parse";

export type { ParseResult } from "./parse";

export interface PickedFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export type WindowAction = "minimize" | "maximize" | "close";

export interface MarkExtractApi {
  readonly version: string;
  /**
   * 드롭된 File 에서 실제 경로를 얻는다.
   *
   * sandbox: true 인 렌더러에는 File.path 가 없다. webUtils 는 preload 에서만
   * 쓸 수 있어 여기를 통해야 한다.
   */
  getFilePath(file: File): string;
  /** 파일 선택 대화상자. 취소하면 빈 배열. */
  pickFiles(): Promise<PickedFile[]>;
  /** 명령줄로 받은 문서. 탐색기에서 "연결 프로그램"으로 열 때 들어온다. */
  initialFiles(): Promise<PickedFile[]>;
  /** 경로의 문서를 Markdown 으로 변환한다. */
  convert(filePath: string): Promise<ParseResult>;
  /** 프레임 없는 창이라 캡션 버튼을 우리가 그린다. */
  window(action: WindowAction): Promise<void>;
}

declare global {
  interface Window {
    readonly markExtract: MarkExtractApi;
  }
}
