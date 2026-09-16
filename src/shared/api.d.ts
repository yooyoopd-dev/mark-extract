/** preload 가 contextBridge 로 노출하는 표면. preload 와 렌더러가 함께 쓴다. */
import type { ParseResult } from "./parse";

export type { ParseResult } from "./parse";

export interface MarkExtractApi {
  readonly version: string;
  /**
   * 드롭된 File 에서 실제 경로를 얻는다.
   *
   * sandbox: true 인 렌더러에는 File.path 가 없다. webUtils 는 preload 에서만
   * 쓸 수 있어 여기를 통해야 한다.
   */
  getFilePath(file: File): string;
  /** 경로의 문서를 Markdown 으로 변환한다. */
  convert(filePath: string): Promise<ParseResult>;
}

declare global {
  interface Window {
    readonly markExtract: MarkExtractApi;
  }
}
