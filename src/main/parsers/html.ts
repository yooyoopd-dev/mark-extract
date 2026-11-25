/**
 * HTML → Markdown (docs/design/02-parser-adapters.md#html--turndown).
 *
 * turndown 으로 문단·제목·목록·링크·강조를 옮긴다. 표와 그림은 다른 어댑터와 **같은
 * 코드**를 지나게 한다.
 *
 *   표   turndown 은 <table> 을 HTML 그대로 남기고(keep), html-in-markdown.ts 가
 *        PDF·DOCX 출력과 같은 규칙으로 파이프 표로 바꾼다 — 병합 펼침과 경고까지
 *   그림 `![](…)` 로 낸 뒤 image-notes.ts 가 `[그림 N]` 위치 표시로 바꾼다. data: URI
 *        의 base64 가 본문에 쏟아지는 것도 이것이 막는다
 *
 * EML 의 HTML 본문도 이 파일의 htmlToMarkdown 을 쓴다 (eml.ts).
 */
import { readFile } from "node:fs/promises";
import TurndownService from "turndown";
import { cleanHtml } from "../html-clean";
import { cleanHtmlInMarkdown } from "../html-in-markdown";
import { noteImages, type ImageMode } from "../image-notes";
import { normalizeMarkdown } from "../normalize";
import type { LogEntry, ParseRequest, ParseResult, Warning } from "../../shared/parse";

const ENGINE = "로컬 · turndown";

/** 문자셋 선언을 찾을 범위. 선언은 <head> 앞쪽에 있다. */
const SNIFF_BYTES = 4096;
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i;

/**
 * 바이트를 글자로. 순서는 BOM → `<meta charset>` → UTF-8 → EUC-KR.
 *
 * 마지막 단계가 EUC-KR 인 이유: 사내 웹 시스템에서 저장한 HTML 은 선언 없이 EUC-KR
 * 인 경우가 있다. UTF-8 로 엄격하게 읽어 보고 깨지면 EUC-KR 로 읽는다 — UTF-8 이
 * 아닌 바이트열이 UTF-8 검사를 통과하는 일은 드물어 이 순서가 안전하다.
 */
export function decodeHtml(bytes: Uint8Array): { text: string; charset: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), charset: "utf-8 (BOM)" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), charset: "utf-16le (BOM)" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), charset: "utf-16be (BOM)" };
  }

  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("latin1");
  const declared = META_CHARSET.exec(head)?.[1];
  if (declared !== undefined) {
    try {
      return { text: new TextDecoder(declared).decode(bytes), charset: `${declared} (선언)` };
    } catch {
      // 디코더가 모르는 이름이면 선언이 없는 것으로 본다.
    }
  }

  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), charset: "utf-8" };
  } catch {
    return { text: new TextDecoder("euc-kr").decode(bytes), charset: "euc-kr (추정)" };
  }
}

/** DOM 노드 중 우리가 쓰는 것만. turndown 은 내부에서 domino 노드를 준다. */
interface DomNode {
  readonly outerHTML: string;
  readonly ownerDocument: { createTextNode(text: string): unknown };
  querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; replaceWith(node: unknown): void }>;
}

function service(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  // <head> 는 turndown 이 본문 맥락으로 파싱하면서 껍데기가 사라져 <title> 만 남는다
  // (실측: 제목이 본문 첫 줄에 한 번 더 나왔다). 그래서 title 을 따로 지운다.
  td.remove(["script", "style", "noscript", "template", "head", "title", "iframe", "object"]);
  // 이스케이프하지 않는다. turndown 은 `* `·`1. `·`_` 앞에 역슬래시를 붙이는데,
  // kordoc 의 같은 동작을 build.25 에서 떼어 냈다 — 원문 글자를 그대로 두는 것이
  // 사용자 결정이다 (02 문서 "kordoc 의 이스케이프를 떼어 낸다"). PDF 도 하지 않는다.
  td.escape = (text: string): string => text;

  // 표는 HTML 그대로 내고 html-in-markdown.ts 가 바꾼다. 다만 셀 안의 <img> 는
  // 그쪽이 글자만 모으므로 **조용히 사라진다** — 그 전에 `![](…)` 글자로 바꿔 두면
  // image-notes.ts 가 셀 안의 `[그림 N]` 으로 받는다.
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as unknown as DomNode;
      const images = Array.from(table.querySelectorAll("img"));
      for (const img of images) {
        img.replaceWith(table.ownerDocument.createTextNode(`![${img.getAttribute("alt") ?? ""}](img)`));
      }
      return `\n\n${table.outerHTML}\n\n`;
    },
  });

  // turndown 기본은 `-   항목` (기호 뒤 공백 셋). 다른 어댑터와 같이 하나로 낸다.
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const parent = node.parentNode as unknown as { nodeName: string; getAttribute(n: string): string | null; children: ArrayLike<unknown> } | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number.parseInt(parent.getAttribute("start") ?? "1", 10);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${(Number.isFinite(start) ? start : 1) + index}. `;
      }
      const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      const next = (node as unknown as { nextSibling: unknown }).nextSibling;
      return prefix + body + (next && !/\n$/.test(body) ? "\n" : "");
    },
  });
  return td;
}

export interface Converted {
  readonly markdown: string;
  readonly warnings: readonly Warning[];
}

/** HTML 문자열을 우리 규칙의 Markdown 으로. EML 본문도 이것을 쓴다. */
export function htmlToMarkdown(html: string, imageMode: ImageMode): Converted {
  // 배치 표·숨김·주석·추적 픽셀을 먼저 걷어 낸다 (build.39, html-clean.ts).
  const raw = service().turndown(cleanHtml(html) as unknown as TurndownService.Node);
  const cleaned = cleanHtmlInMarkdown(raw);
  const noted = noteImages(cleaned.markdown, imageMode);
  return { markdown: normalizeMarkdown(noted.markdown), warnings: [...cleaned.warnings, ...noted.warnings] };
}

export async function parseHtml(request: ParseRequest): Promise<ParseResult> {
  const started = Date.now();
  const log: LogEntry[] = [{ label: "엔진", value: ENGINE }];

  try {
    const { text, charset } = decodeHtml(await readFile(request.filePath));
    log.push({ label: "문자셋", value: charset });

    const { markdown, warnings } = htmlToMarkdown(text, request.options?.imageOutput ?? "note");
    const elapsedMs = Date.now() - started;
    log.push({ label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` });

    if (markdown.trim() === "") {
      return {
        ok: false,
        markdown: "",
        warnings,
        log,
        meta: { engine: ENGINE, elapsedMs },
        error: { code: "EMPTY_OUTPUT", message: "추출된 텍스트가 없습니다.", actions: ["retry-plain"] },
      };
    }
    return { ok: true, markdown, warnings, log, meta: { engine: ENGINE, elapsedMs } };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine: ENGINE, elapsedMs: Date.now() - started },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  }
}
