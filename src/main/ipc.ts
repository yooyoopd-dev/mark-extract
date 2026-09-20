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
import { testHybrid } from "./hybrid-http";
import { probeCli } from "./llm/launch";
import { clearCache, resolveCli } from "./llm/resolve";
import { providerOf } from "./llm/providers";
import { listModels } from "./llm/ollama-http";
import { promptText } from "./llm/prompt";
import { selfTestReport } from "./self-test";
import type { CliStatus, DocOptions, ExportRequest, Settings } from "../shared/doc";
import type { Provider } from "../shared/parse";

const SUPPORTED = ["pdf", "docx", "xlsx", "xls", "pptx"];
const PROVIDERS: readonly Provider[] = ["claude", "gemini", "codex", "ollama"];

const windowOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender);

/**
 * 렌더러가 보낸 옵션에서 아는 값만 추린다.
 *
 * 여기 없는 키는 조용히 사라진다 — 그래서 옵션을 늘릴 때 이 목록을 같이 늘리지
 * 않으면 화면과 어댑터가 멀쩡한데도 기능이 죽는다 (build.25 의 OCR 토글).
 * `verify-queue.mjs` 가 이 함수를 직접 부른다.
 */
export function cleanOptions(raw: unknown): DocOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const options: DocOptions = {};
  const out = options as Record<string, unknown>;

  if (o["tableMethod"] === "default" || o["tableMethod"] === "cluster") out["tableMethod"] = o["tableMethod"];
  if (typeof o["includeHeaderFooter"] === "boolean") out["includeHeaderFooter"] = o["includeHeaderFooter"];
  if (o["imageOutput"] === "off" || o["imageOutput"] === "embedded" || o["imageOutput"] === "external") {
    out["imageOutput"] = o["imageOutput"];
  }
  if (typeof o["pages"] === "string" && o["pages"].trim() !== "") out["pages"] = o["pages"].trim();

  // OCR·구조 트리. false 도 실어야 한다 — 빈 값으로 보고 버리면 한 번 켠 옵션을
  // 끄는 길이 없어진다.
  if (typeof o["ocr"] === "boolean") out["ocr"] = o["ocr"];
  if (typeof o["hybridFullPages"] === "boolean") out["hybridFullPages"] = o["hybridFullPages"];
  if (typeof o["useStructTree"] === "boolean") out["useStructTree"] = o["useStructTree"];

  if (o["engine"] === "local" || o["engine"] === "llm") out["engine"] = o["engine"];
  if (PROVIDERS.includes(o["provider"] as Provider)) out["provider"] = o["provider"];
  // 모델 이름은 자유 문자열이라 값을 검사할 수 없다. 길이만 막는다 — 인자로 나가므로
  // 무한정 받을 이유가 없다.
  if (typeof o["model"] === "string" && o["model"].trim() !== "") {
    out["model"] = o["model"].trim().slice(0, 200);
  }
  if (o["inputMode"] === "A" || o["inputMode"] === "B") out["inputMode"] = o["inputMode"];
  // 1분 ~ 3시간. 사람이 실수로 0 이나 음수를 넣어 즉시 실패하지 않게 막는다.
  if (typeof o["timeoutMs"] === "number" && Number.isFinite(o["timeoutMs"])) {
    out["timeoutMs"] = Math.min(Math.max(Math.trunc(o["timeoutMs"]), 60_000), 3 * 60 * 60_000);
  }
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
    return result.canceled
      ? { added: 0, skipped: 0, oversized: [], unsupported: [] }
      : queue.add(result.filePaths);
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

  /* LLM 진단 ------------------------------------------- */
  //
  // 설정 화면이 쓴다. 사내망 PC 는 로그 파일을 반출할 수 없어, CLI 를 찾지 못했을 때
  // 무엇을 어디서 어떻게 찾았는지 화면에서 읽고 옮겨 적을 수 있어야 한다.
  ipcMain.handle("llm:detect", async (): Promise<CliStatus[]> => {
    clearCache();
    return Promise.all(
      PROVIDERS.map(async (provider) => {
        const { command, report } = await resolveCli(provider);
        if (command === null) {
          return { provider, label: providerOf(provider).label, found: false, command, report, runnable: false, detail: "" };
        }
        // 찾았다고 도는 것은 아니다. 한 번 띄워 봐야 안다.
        const probe = await probeCli(command);
        return {
          provider,
          label: providerOf(provider).label,
          found: true,
          command,
          report: [...report, probe.ok ? `실행 확인: ${probe.detail}` : `실행하지 못했습니다: ${probe.detail}`],
          runnable: probe.ok,
          detail: probe.detail,
        };
      }),
    );
  });

  // 프롬프트 전문. 사내 검수 대상이 될 수 있어 열람·복사를 제공한다 (결정 25).
  // 실제로 쓰이는 것과 같은 함수에서 만들어야 의미가 있다.
  ipcMain.handle("llm:prompt", () => {
    const { inputMode, language } = settings();
    return promptText(inputMode, language);
  });

  // 사내 PC 에서 확인할 수 있는 것을 앱 안에서 돌린다. 명령 프롬프트로도 되지만
  // 단일 exe 는 stdout 이 호출자에게 닿지 않아 화면에 아무것도 뜨지 않는다.
  ipcMain.handle("app:self-test", () => selfTestReport());

  // 설치된 Ollama 모델. 본문 생성은 CLI 가 하고 이 조회만 루프백 HTTP 다 (결정 15).
  ipcMain.handle("llm:ollamaModels", () => listModels(settings().ollamaUrl));

  /* OCR — hybrid 서버 --------------------------------- */
  //
  // 본문 변환은 Java CLI 가 --hybrid-url 로 직접 부른다. 여기서 HTTP 는 살아 있는지
  // 보는 것 하나뿐이고, 그 결과가 인스펙터 OCR 토글의 자물쇠를 연다.
  ipcMain.handle("hybrid:test", (_e, url?: unknown) =>
    testHybrid(typeof url === "string" && url.trim() !== "" ? url : settings().hybridUrl),
  );

  /* 설정 ------------------------------------------------ */
  ipcMain.handle("settings:get", () => settings());
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    // 아는 키만 받는다. 값 범위는 settings.ts 의 normalize 가 다시 본다.
    const clean: Partial<Settings> = {};
    const p = (patch ?? {}) as Record<string, unknown>;

    for (const key of ["concurrency", "llmTimeoutMin", "maxFileSizeMb"] as const) {
      if (typeof p[key] === "number") clean[key] = p[key] as number;
    }
    for (const key of ["frontmatter", "ocrByDefault"] as const) {
      if (typeof p[key] === "boolean") clean[key] = p[key] as boolean;
    }
    for (const key of ["model", "ollamaUrl", "hybridUrl"] as const) {
      if (typeof p[key] === "string") clean[key] = p[key] as string;
    }
    // 열거형은 normalize 가 모르는 값을 기본값으로 되돌리므로 그대로 넘긴다.
    for (const key of ["theme", "defaultEngine", "provider", "inputMode", "imageOutput", "language"] as const) {
      if (typeof p[key] === "string") clean[key] = p[key] as never;
    }
    if (p["outputDir"] === null || typeof p["outputDir"] === "string") {
      clean.outputDir = p["outputDir"] as string | null;
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
