/**
 * IPC 채널 등록. 채널은 하나씩 이름을 붙여 열고, 렌더러가 임의의 호출을 할 수
 * 있는 통로는 만들지 않는다 (docs/design/01-architecture.md).
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { detectFormat } from "./detect-format";
import { parsePdf } from "./parsers/pdf-opendataloader";
import { parseOffice } from "./parsers/office-kordoc";
import { parsePptx } from "./parsers/pptx";
import type { ParseRequest, ParseResult } from "../shared/parse";
import type { PickedFile } from "../shared/api";

function unsupported(detail: string): ParseResult {
  return {
    ok: false,
    markdown: "",
    warnings: [],
    log: [{ label: "형식", value: detail }],
    meta: { engine: "-", elapsedMs: 0 },
    error: {
      code: "UNSUPPORTED_FORMAT",
      message: "PDF · DOCX · XLSX · XLS · PPTX 만 변환합니다. HWP 계열은 지원하지 않습니다.",
      actions: [],
    },
  };
}

/** 확장자가 아니라 내용으로 고른 어댑터에 넘긴다. */
export async function convert(request: ParseRequest): Promise<ParseResult> {
  const format = await detectFormat(request.filePath);

  switch (format) {
    case "pdf":
      return parsePdf(request);
    case "docx":
    case "xlsx":
    case "xls":
      return parseOffice(request, format);
    case "pptx":
      return parsePptx(request);
    default:
      return unsupported("알 수 없음 (매직 바이트로 판별 실패)");
  }
}

const SUPPORTED = ["pdf", "docx", "xlsx", "xls", "pptx"];

/**
 * 명령줄로 받은 문서. `MarkExtract.exe 보고서.pdf` 처럼 탐색기의 "연결 프로그램"
 * 으로 열 때 들어온다.
 *
 * Electron 의 argv 에는 실행 파일과 스위치가 섞여 있어 확장자로 거른다.
 */
async function initialFiles(): Promise<PickedFile[]> {
  const candidates = process.argv
    .slice(1)
    .filter((arg) => !arg.startsWith("-"))
    .filter((arg) => SUPPORTED.includes(extname(arg).slice(1).toLowerCase()));

  const files: PickedFile[] = [];
  for (const path of candidates) {
    try {
      files.push({ path, name: basename(path), size: (await stat(path)).size });
    } catch {
      // 존재하지 않는 경로는 조용히 건너뛴다. 스위치가 파일처럼 보였을 수 있다.
    }
  }
  return files;
}

export function registerIpc(): void {
  ipcMain.handle("doc:convert", (_event, filePath: string) => convert({ filePath }));

  ipcMain.handle("doc:initial", () => initialFiles());

  ipcMain.handle("doc:pick", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window ?? { } as BrowserWindow, {
      title: "변환할 문서 선택",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "문서", extensions: SUPPORTED }],
    });
    if (result.canceled) return [];

    return Promise.all(
      result.filePaths.map(async (path) => ({
        path,
        name: basename(path),
        size: (await stat(path)).size,
      })),
    );
  });

  ipcMain.handle("window:action", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;

    // 렌더러가 보낸 값이므로 아는 것만 받는다.
    if (action === "minimize") window.minimize();
    else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === "close") window.close();
  });
}
