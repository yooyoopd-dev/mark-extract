/**
 * IPC 채널 등록 (docs/design/01-architecture.md 의 표).
 *
 * 채널은 하나씩 이름을 붙여 열고, 렌더러가 임의의 호출을 할 수 있는 통로는 만들지
 * 않는다. 렌더러가 보낸 값은 아는 것만 받는다.
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as queue from "./queue";
import { settings, updateSettings } from "./settings";
import { addWatch, removeWatch } from "./watch";
import type { DocOptions, ExportRequest, Settings } from "../shared/doc";

const SUPPORTED = ["pdf", "docx", "xlsx", "xls", "pptx"];

const windowOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender);

/** 렌더러가 보낸 옵션에서 아는 값만 추린다. */
function cleanOptions(raw: unknown): DocOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const options: DocOptions = {};
  const out = options as Record<string, unknown>;

  if (o["tableMethod"] === "default" || o["tableMethod"] === "cluster") out["tableMethod"] = o["tableMethod"];
  if (typeof o["includeHeaderFooter"] === "boolean") out["includeHeaderFooter"] = o["includeHeaderFooter"];
  if (o["imageOutput"] === "off" || o["imageOutput"] === "embedded" || o["imageOutput"] === "external") {
    out["imageOutput"] = o["imageOutput"];
  }
  if (typeof o["pages"] === "string" && o["pages"].trim() !== "") out["pages"] = o["pages"].trim();
  return options;
}

export function registerIpc(): void {
  /* 문서 ------------------------------------------------ */
  ipcMain.handle("doc:list", () => queue.list());
  ipcMain.handle("doc:markdown", (_e, id: string) => queue.markdownOf(id));
  ipcMain.handle("doc:add", (_e, paths: string[]) => queue.add(paths));
  ipcMain.handle("doc:remove", (_e, id: string) => queue.remove(id));
  ipcMain.handle("doc:star", (_e, id: string, value: boolean) => queue.star(id, value === true));
  ipcMain.handle("doc:cancel", (_e, id: string) => queue.cancel(id));
  ipcMain.handle("doc:reconvert", (_e, id: string, options: unknown) =>
    queue.reconvert(id, cleanOptions(options)),
  );
  ipcMain.handle("doc:initial", () => queue.initialPaths());

  ipcMain.handle("doc:pick", async (event) => {
    const window = windowOf(event);
    const result = await dialog.showOpenDialog(window!, {
      title: "변환할 문서 선택",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "문서", extensions: SUPPORTED }],
    });
    return result.canceled ? { added: 0, skipped: 0 } : queue.add(result.filePaths);
  });

  /* 내보내기 -------------------------------------------- */
  ipcMain.handle("export:pickDir", async (event) => {
    const window = windowOf(event);
    const previous = settings().outputDir;
    const options: Electron.OpenDialogOptions = {
      title: "저장할 폴더 선택",
      properties: ["openDirectory", "createDirectory"],
    };
    if (previous !== null) options.defaultPath = previous;

    const result = await dialog.showOpenDialog(window!, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("export:markdown", async (_e, request: ExportRequest) => {
    const outputDir = String(request.outputDir ?? "");
    if (outputDir === "") return { written: 0, failed: 0, outputDir: "" };

    updateSettings({ outputDir, frontmatter: request.frontmatter === true });
    return queue.exportDocs({
      ids: Array.isArray(request.ids) ? request.ids.map(String) : [],
      outputDir,
      frontmatter: request.frontmatter === true,
    });
  });

  ipcMain.handle("export:reveal", (_e, path: string) => shell.openPath(path));

  /* 감시 폴더 ------------------------------------------- */
  ipcMain.handle("watch:add", async (event) => {
    const window = windowOf(event);
    const result = await dialog.showOpenDialog(window!, {
      title: "감시할 폴더 선택",
      properties: ["openDirectory"],
    });
    const path = result.canceled ? null : result.filePaths[0];
    return path ? addWatch(path) : settings().watch;
  });
  ipcMain.handle("watch:remove", (_e, path: string) => removeWatch(String(path)));

  /* 설정 ------------------------------------------------ */
  ipcMain.handle("settings:get", () => settings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    const clean: Partial<Settings> = {};
    if (typeof patch?.concurrency === "number") clean.concurrency = patch.concurrency;
    if (typeof patch?.frontmatter === "boolean") clean.frontmatter = patch.frontmatter;
    if (patch?.theme === "system" || patch?.theme === "light" || patch?.theme === "dark") {
      clean.theme = patch.theme;
    }
    return updateSettings(clean);
  });

  /* 창 ------------------------------------------------- */
  ipcMain.handle("window:action", (event, action: unknown) => {
    const window = windowOf(event);
    if (!window) return;

    if (action === "minimize") window.minimize();
    else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === "close") window.close();
  });
}

/** 큐가 바뀔 때마다 열려 있는 창에 알린다. */
export function broadcastChanges(): void {
  queue.events.on("changed", () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("doc:changed", queue.list());
    }
  });
}
