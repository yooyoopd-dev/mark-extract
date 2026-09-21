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

function failure(detail: string, code: string, message: string): ParseResult {
  return {
    ok: false,
    markdown: "",
    warnings: [],
    log: [{ label: "형식", value: detail }],
    meta: { engine: "-", elapsedMs: 0 },
    error: { code, message, actions: [] },
  };
}

const unsupported = (detail: string): ParseResult =>
  failure(
    detail,
    "UNSUPPORTED_FORMAT",
    "PDF · DOCX · XLSX · XLS · PPTX 만 변환합니다. HWP 계열은 지원하지 않습니다.",
  );

/**
 * 암호·DRM 으로 감싼 문서.
 *
 * build.25 실측에서 드러났다. 사내 문서는 DRM 이 기본이라 이 경로가 흔한데,
 * 그때까지는 "HWP 계열은 지원하지 않습니다" 라는 엉뚱한 문구를 보여 주고 있었다.
 * 앱이 DRM 을 풀 수는 없으므로 무엇을 해야 하는지만 정확히 말한다.
 */
const protectedDoc = (detail: string): ParseResult =>
  failure(
    detail,
    "DRM_PROTECTED",
    "암호 또는 DRM 으로 보호된 문서로 보입니다. DRM 을 해제한 사본으로 다시 시도해 주세요.",
  );

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
    case "protected":
      return protectedDoc("암호·DRM 컨테이너 (OLE2 안에 문서가 들어 있다)");
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
