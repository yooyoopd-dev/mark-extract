/**
 * 포맷을 보고 어댑터를 고른다.
 *
 * 확장자가 아니라 내용(매직 바이트)으로 판별한다 — 사용자가 받은 파일의 확장자가
 * 실제와 다른 경우가 드물지 않고, 그때는 내용을 따라야 한다.
 */
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
