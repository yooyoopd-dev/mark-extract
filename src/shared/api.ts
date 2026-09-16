/** preload 가 contextBridge 로 노출하는 표면. preload 와 렌더러가 함께 쓴다. */
export interface MarkExtractApi {
  readonly version: string;
}

declare global {
  interface Window {
    readonly markExtract: MarkExtractApi;
  }
}
