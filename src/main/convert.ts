/**
 * 포맷을 보고 어댑터를 고른다.
 *
 * 확장자가 아니라 내용(매직 바이트)으로 판별한다 — 사용자가 받은 파일의 확장자가
 * 실제와 다른 경우가 드물지 않고, 그때는 내용을 따라야 한다.
 */
import { detectFormat } from "./detect-format";
import { parseWithLlm } from "./llm/run";
import { settings } from "./settings";
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

/** 형식을 보고 로컬 어댑터를 고른다. LLM 경로의 모드 B 1단계도 이것을 쓴다. */
async function convertLocally(request: ParseRequest): Promise<ParseResult> {
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

export async function convert(request: ParseRequest): Promise<ParseResult> {
  // 서버 주소는 문서별이 아니라 앱 전체 설정이다. 모드 B 의 로컬 단계도 이 경로를
  // 지나므로 여기서 한 번만 실어 준다.
  const withHybrid: ParseRequest = { ...request, hybridUrl: settings().hybridUrl };

  // 엔진 선택은 문서 단위다 (결정 7). 기본은 로컬 — 재현 가능한 결과가 기본이어야 한다.
  if (request.options?.engine !== "llm") return convertLocally(withHybrid);

  // 출력 언어와 Ollama 주소도 앱 전체 설정이다.
  const { language, ollamaUrl } = settings();
  return parseWithLlm({ ...withHybrid, language, ollamaUrl }, convertLocally);
}
