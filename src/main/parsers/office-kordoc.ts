/**
 * DOCX · XLSX · XLS → Markdown (docs/design/02-parser-adapters.md).
 *
 * kordoc 의 포맷별 함수를 직접 부른다. parse() 자동 판별을 쓰지 않는 이유는 두
 * 가지다. 우리가 이미 매직 바이트로 포맷을 확정했고, 자동 판별이 HWP·PDF 경로로
 * 흘러가는 것을 막아야 한다 — HWP 는 지원 대상이 아니고 PDF 는 opendataloader
 * 몫이다.
 *
 * PDF 와 달리 줄 잇기(joinWrappedLines)를 쓰지 않는다. 접힌 줄이 없고, 스프레드
 * 시트에서 연속한 두 줄은 서로 다른 셀이라 이으면 값이 뭉개진다.
 */
import { readFile } from "node:fs/promises";
import { parseDocx, parseXls, parseXlsx } from "kordoc";
import type { ParseOptions, ParseResult as KordocResult } from "kordoc";
import { cleanHtmlInMarkdown } from "../html-in-markdown";
import { normalizeMarkdown } from "../normalize";
import type { LogEntry, ParseRequest, ParseResult, RetryAction, Warning } from "../../shared/parse";

type OfficeFormat = "docx" | "xlsx" | "xls";

const ENGINE: Record<OfficeFormat, string> = {
  docx: "로컬 · kordoc (DOCX)",
  xlsx: "로컬 · kordoc (XLSX)",
  xls: "로컬 · kordoc (XLS)",
};

const PARSER: Record<OfficeFormat, (buffer: ArrayBuffer, options?: ParseOptions) => Promise<KordocResult>> = {
  docx: parseDocx,
  xlsx: parseXlsx,
  xls: parseXls,
};

/** 사용자에게 배지로 띄울 경고. 나머지는 로그에만 남긴다. */
const SURFACED = new Set(["SKIPPED_IMAGE", "SKIPPED_OLE", "TRUNCATED_TABLE", "PARTIAL_PARSE"]);

/** kordoc ErrorCode → 실패 문구와 버튼 (docs/design/02-parser-adapters.md 의 표) */
const FAILURE: Record<string, { message: string; actions: RetryAction[] }> = {
  ENCRYPTED: { message: "열기 암호가 필요합니다.", actions: ["retry-with-password"] },
  DRM_PROTECTED: { message: "DRM 으로 보호된 문서입니다. 앱에서 풀 수 없습니다.", actions: [] },
  CORRUPTED: { message: "파일이 손상되었습니다.", actions: ["retry-plain"] },
  UNSUPPORTED_FORMAT: { message: "지원하지 않는 형식입니다.", actions: [] },
  ZIP_BOMB: { message: "비정상적으로 큰 압축 구조라 중단했습니다.", actions: [] },
  DECOMPRESSION_BOMB: { message: "비정상적으로 큰 압축 구조라 중단했습니다.", actions: [] },
  OUTPUT_TOO_LARGE: { message: "결과가 너무 큽니다. 페이지 범위를 지정해 보세요.", actions: ["retry-plain"] },
  EMPTY_INPUT: { message: "빈 파일입니다.", actions: [] },
};

export async function parseOffice(request: ParseRequest, format: OfficeFormat): Promise<ParseResult> {
  const started = Date.now();
  const engine = ENGINE[format];
  const log: LogEntry[] = [{ label: "엔진", value: engine }];

  try {
    const file = await readFile(request.filePath);
    // kordoc 은 ArrayBuffer 를 받는다. Buffer 는 풀 안의 조각일 수 있어 범위를 잘라 준다.
    const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;

    const options: ParseOptions = {};
    if (request.options?.pages) options.pages = request.options.pages;
    if (request.options?.password) options.password = request.options.password;
    if (request.onProgress) options.onProgress = request.onProgress;

    const result = await PARSER[format](bytes, options);
    const elapsedMs = Date.now() - started;

    if (request.signal?.aborted) throw new Error("변환이 취소되었습니다.");

    if (!result.success) {
      // kordoc 은 사람이 읽을 메시지를 error 에, 분류를 code 에 따로 담는다.
      const code = result.code ?? "PARSE_ERROR";
      const known = FAILURE[code];
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "오류 코드", value: code }, { label: "엔진 메시지", value: result.error }],
        meta: { engine, elapsedMs },
        error: {
          code,
          message: known?.message ?? result.error ?? "변환에 실패했습니다.",
          actions: known?.actions ?? ["retry-plain"],
        },
      };
    }

    const warnings: Warning[] = (result.warnings ?? [])
      .filter((w) => SURFACED.has(w.code))
      .map((w) => ({ code: w.code, message: w.message, ...(w.page === undefined ? {} : { page: w.page }) }));

    // kordoc 은 병합 셀이나 복합 셀 내용이 있는 표를 <table> 로 낸다.
    const cleaned = cleanHtmlInMarkdown(result.markdown);
    warnings.push(...cleaned.warnings);
    const markdown = normalizeMarkdown(cleaned.markdown);

    if (markdown.trim() === "") {
      return {
        ok: false,
        markdown: "",
        warnings,
        log: [...log, { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` }],
        meta: { engine, elapsedMs },
        error: { code: "EMPTY_OUTPUT", message: "추출된 텍스트가 없습니다.", actions: ["retry-plain"] },
      };
    }

    return {
      ok: true,
      markdown,
      warnings,
      log: [
        ...log,
        { label: "시트/섹션", value: String(result.pageCount ?? "-") },
        { label: "경고", value: `${(result.warnings ?? []).length}건 (표시 ${warnings.length}건)` },
        { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` },
      ],
      meta: { ...(result.pageCount === undefined ? {} : { pages: result.pageCount }), engine, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine, elapsedMs: Date.now() - started },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  }
}
