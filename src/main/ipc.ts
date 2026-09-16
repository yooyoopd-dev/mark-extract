/**
 * IPC 채널 등록. 채널은 하나씩 이름을 붙여 열고, 렌더러가 임의의 호출을 할 수
 * 있는 통로는 만들지 않는다 (docs/design/01-architecture.md).
 */
import { ipcMain } from "electron";
import { extname } from "node:path";
import { parsePdf } from "./parsers/pdf-opendataloader";
import type { ParseResult } from "../shared/parse";

function unsupported(ext: string): ParseResult {
  return {
    ok: false,
    markdown: "",
    warnings: [],
    log: [{ label: "형식", value: ext || "(확장자 없음)" }],
    meta: { engine: "-", elapsedMs: 0 },
    error: {
      code: "UNSUPPORTED_FORMAT",
      message: `2단계에서는 PDF 만 변환합니다. DOCX·XLSX·PPTX 는 3단계에서 들어옵니다.`,
      actions: [],
    },
  };
}

export function registerIpc(): void {
  ipcMain.handle("doc:convert", async (_event, filePath: string): Promise<ParseResult> => {
    const ext = extname(filePath).toLowerCase();
    // 3단계에서 매직 바이트 판별과 나머지 어댑터가 들어온다.
    if (ext !== ".pdf") return unsupported(ext);
    return parsePdf({ filePath });
  });
}
