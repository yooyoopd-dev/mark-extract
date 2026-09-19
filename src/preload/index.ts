/**
 * 렌더러에 노출하는 유일한 통로.
 *
 * 채널을 그대로 넘겨주는 와일드카드 전달자는 두지 않는다 — 렌더러가 임의의 IPC
 * 를 부를 수 있게 되면 contextIsolation 이 무의미해진다
 * (docs/design/01-architecture.md). 채널은 필요할 때 하나씩 이름을 붙여 연다.
 *
 * sandbox: true 라서 이 파일은 CommonJS 로 컴파일된다 (tsconfig.node.json).
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AddResult, CliStatus, DocOptions, DocView, ExportResult, MarkExtractApi, Settings, WatchFolder, WindowAction } from "../shared/api";

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: MarkExtractApi = {
  version: process.versions.electron,
  getFilePath: (file) => webUtils.getPathForFile(file),

  list: () => call<DocView[]>("doc:list"),
  markdown: (id) => call<string>("doc:markdown", id),
  add: (paths) => call<AddResult>("doc:add", paths),
  remove: (id) => call<void>("doc:remove", id),
  star: (id, value) => call<void>("doc:star", id, value),
  cancel: (id) => call<void>("doc:cancel", id),
  reconvert: (id, options: DocOptions) => call<void>("doc:reconvert", id, options),
  pickFiles: () => call<AddResult>("doc:pick"),
  initialFiles: () => call<string[]>("doc:initial"),

  onChanged: (handler) => {
    const listener = (_event: unknown, docs: DocView[]): void => handler(docs);
    ipcRenderer.on("doc:changed", listener);
    return () => ipcRenderer.removeListener("doc:changed", listener);
  },

  pickOutputDir: () => call<string | null>("export:pickDir"),
  exportMarkdown: (request) => call<ExportResult>("export:markdown", request),
  reveal: (path) => call<string>("export:reveal", path),

  addWatch: () => call<WatchFolder[]>("watch:add"),
  removeWatch: (path) => call<WatchFolder[]>("watch:remove", path),

  getSettings: () => call<Settings>("settings:get"),
  setSettings: (patch: Partial<Settings>) => call<Settings>("settings:set", patch),

  detectCli: () => call<CliStatus[]>("llm:detect"),
  promptText: () => call<string>("llm:prompt"),
  ollamaModels: () => call<{ ok: boolean; models: string[]; detail: string }>("llm:ollamaModels"),
  /** hybrid OCR 서버가 살아 있는지. url 을 주면 그 주소로, 없으면 설정값으로 본다. */
  testHybrid: (url?: string) => call<{ ok: boolean; detail: string; ms: number }>("hybrid:test", url),

  window: (action: WindowAction) => call<void>("window:action", action),
};

contextBridge.exposeInMainWorld("markExtract", api);
