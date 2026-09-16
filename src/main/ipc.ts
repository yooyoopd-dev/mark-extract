/**
 * IPC 채널 등록. 채널은 하나씩 이름을 붙여 열고, 렌더러가 임의의 호출을 할 수
 * 있는 통로는 만들지 않는다 (docs/design/01-architecture.md).
 */
import { ipcMain } from "electron";
import { detectFormat } from "./detect-format";
import { parsePdf } from "./parsers/pdf-opendataloader";
import { parseOffice } from "./parsers/office-kordoc";
import { parsePptx } from "./parsers/pptx";
import type { ParseRequest, ParseResult } from "../shared/parse";

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

export function registerIpc(): void {
  ipcMain.handle("doc:convert", (_event, filePath: string) => convert({ filePath }));
}
