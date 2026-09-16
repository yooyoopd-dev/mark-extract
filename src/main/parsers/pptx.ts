/**
 * PPTX → Markdown (docs/design/02-parser-adapters.md).
 *
 * kordoc 은 PPTX 를 지원하지 않는다 (FileType 에 없고 패키지 전체에
 * presentationml 문자열도 없다). 그래서 markitdown(MIT, Microsoft)의 PPTX 변환
 * 규칙을 TypeScript 로 옮겼다. markitdown 은 python-pptx 기반이라 코드를 그대로
 * 쓸 수 없고, Python 런타임 동봉은 단일 exe 취지와 충돌한다.
 *
 * 옮긴 규칙
 *   슬라이드 경계   <!-- Slide number: N -->
 *   도형 정렬       위→아래, 같은 높이면 왼쪽→오른쪽
 *   제목 자리표시자  # 제목
 *   표              Markdown 표 (markitdown 은 HTML 을 거치지만 우리는 바로 만든다)
 *   이미지          ![대체텍스트](파일명)
 *   발표자 노트     ### Notes:
 *   그룹 도형       같은 규칙으로 재귀
 *
 * jszip 과 @xmldom/xmldom 은 kordoc 이 이미 가져오는 의존성이라 추가 설치가 없다.
 */
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import { normalizeMarkdown } from "../normalize";
import type { LogEntry, ParseRequest, ParseResult, Warning } from "../../shared/parse";

const ENGINE = "로컬 · 자체 구현 (PPTX)";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// DOM 타입은 main 쪽 tsconfig 에 없다 (lib: ES2022). xmldom 자체 타입을 쓴다.
type Doc = XmlDocument;
type El = XmlElement;

const parser = new DOMParser({ onError: () => {} });

/** XML 을 읽어 루트 엘리먼트를 돌려준다. 망가진 XML 이면 null. */
function parseXml(text: string): El | null {
  const doc: Doc = parser.parseFromString(text, "application/xml");
  return doc.documentElement;
}

const children = (node: El, ns: string, name: string): El[] =>
  Array.from(node.getElementsByTagNameNS(ns, name));

/** 도형 안의 모든 a:t 를 문단 단위로 모은다. */
function shapeText(shape: El): string[] {
  const paragraphs: string[] = [];
  for (const p of children(shape, A, "p")) {
    const text = children(p, A, "t")
      .map((t) => t.textContent ?? "")
      .join("")
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

/** 제목 자리표시자인지. ph type 이 title 또는 ctrTitle 이면 제목이다. */
function isTitle(shape: El): boolean {
  for (const ph of children(shape, P, "ph")) {
    const type = ph.getAttribute("type");
    if (type === "title" || type === "ctrTitle") return true;
  }
  return false;
}

/**
 * (top, left). 없으면 뒤로 민다 — 읽기 순서를 흐트러뜨리지 않기 위해서다.
 *
 * 자리표시자는 a:off 를 생략하고 슬라이드 레이아웃에서 위치를 물려받는 일이
 * 흔하다. markitdown 은 python-pptx 가 상속을 풀어 준 값을 쓰지만 우리는 XML 만
 * 읽으므로 알 수 없다. 그래서 제목은 위치와 무관하게 맨 앞으로 보낸다 (아래
 * renderShapes 참조) — 슬라이드 제목은 그 슬라이드의 머리이므로 그게 맞다.
 */
function position(shape: El): [number, number] {
  const off = children(shape, A, "off")[0];
  if (!off) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Number(off.getAttribute("y") ?? 0), Number(off.getAttribute("x") ?? 0)];
}

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

function tableToMarkdown(graphicFrame: El): string[] {
  const table = children(graphicFrame, A, "tbl")[0];
  if (!table) return [];

  const rows = children(table, A, "tr").map((tr) =>
    children(tr, A, "tc").map((tc) => escapeCell(shapeText(tc).join(" "))),
  );
  const header = rows[0];
  if (!header) return [];

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? "");

  return [
    `| ${pad(header).join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
}

function imageToMarkdown(shape: El, rels: Map<string, string>): string | null {
  const blip = children(shape, A, "blip")[0];
  if (!blip) return null;

  const id = blip.getAttributeNS(R, "embed") ?? blip.getAttribute("r:embed");
  const target = id ? rels.get(id) : undefined;

  // 대체텍스트는 descr → 도형 이름 순으로 채운다 (markitdown 과 같은 우선순위).
  const props = children(shape, P, "cNvPr")[0];
  const alt = (props?.getAttribute("descr") || props?.getAttribute("name") || "image")
    .replace(/[\r\n]+/g, " ")
    .trim();

  return `![${alt}](${target ? target.replace(/^\.\.\//, "") : "image"})`;
}

/** 관계 파일에서 rId → 대상 경로를 읽는다. */
async function relations(zip: JSZip, slidePath: string): Promise<Map<string, string>> {
  const name = slidePath.replace(/([^/]+)$/, "_rels/$1.rels");
  const file = zip.file(name);
  const map = new Map<string, string>();
  if (!file) return map;

  const root = parseXml(await file.async("string"));
  if (!root) return map;

  for (const rel of children(root, "*", "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

/** 엘리먼트의 직계 자식만 (getElementsByTagNameNS 는 모든 자손을 훑는다). */
function directChildren(node: El): El[] {
  const out: El[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) out.push(child as El);
  }
  return out;
}

/** 도형이 담긴 컨테이너를 찾는다: p:sld > p:cSld > p:spTree */
function shapeTree(slideRoot: El): El | null {
  return children(slideRoot, P, "spTree")[0] ?? null;
}

/**
 * 한 컨테이너의 도형들을 읽기 순서대로 마크다운 줄로 만든다.
 *
 * 직계 자식만 본다 — 그룹 안의 도형은 재귀에서 다루므로 여기서 또 세면 중복된다.
 */
function renderShapes(container: El, rels: Map<string, string>, warnings: Warning[], slide: number): string[] {
  const out: string[] = [];

  const ordered = directChildren(container)
    .filter((n) => ["sp", "graphicFrame", "pic", "grpSp"].includes(n.localName ?? ""))
    .map((node) => ({ node, title: isTitle(node), at: position(node) }))
    // 제목 먼저, 그 다음 위→아래·왼쪽→오른쪽.
    .sort((a, b) => Number(b.title) - Number(a.title) || a.at[0] - b.at[0] || a.at[1] - b.at[1]);

  for (const { node } of ordered) {
    const tag = node.localName;

    if (tag === "grpSp") {
      out.push(...renderShapes(node, rels, warnings, slide));
      continue;
    }

    if (tag === "graphicFrame") {
      const table = tableToMarkdown(node);
      if (table.length > 0) {
        out.push("", ...table, "");
      } else {
        // 차트의 캐시 데이터까지는 아직 다루지 않는다.
        out.push("", "[unsupported chart]", "");
        warnings.push({ code: "UNSUPPORTED_ELEMENT", message: "표가 아닌 개체를 건너뛰었습니다.", page: slide });
      }
      continue;
    }

    if (tag === "pic") {
      const image = imageToMarkdown(node, rels);
      if (image) out.push("", image, "");
      else warnings.push({ code: "SKIPPED_IMAGE", message: "그림을 읽지 못했습니다.", page: slide });
      continue;
    }

    const paragraphs = shapeText(node);
    if (paragraphs.length === 0) continue;

    if (isTitle(node)) {
      out.push("", `# ${paragraphs.join(" ")}`, "");
    } else {
      // 문단은 문단으로 남긴다. 줄만 바꾸면 마크다운에서 한 덩어리로 렌더된다.
      for (const text of paragraphs) out.push("", text);
      out.push("");
    }
  }

  return out;
}

async function slideNotes(zip: JSZip, index: number): Promise<string[]> {
  const file = zip.file(`ppt/notesSlides/notesSlide${index}.xml`);
  if (!file) return [];

  const root = parseXml(await file.async("string"));
  if (!root) return [];

  const lines: string[] = [];
  for (const shape of children(root, P, "sp")) {
    // 슬라이드 번호 자리표시자는 노트 본문이 아니다.
    if (children(shape, P, "ph").some((ph) => ph.getAttribute("type") === "sldNum")) continue;
    lines.push(...shapeText(shape));
  }
  return lines.length > 0 ? ["", "### Notes:", "", ...lines, ""] : [];
}

/** presentation.xml 의 순서대로 슬라이드 경로를 돌려준다. */
async function slideOrder(zip: JSZip): Promise<string[]> {
  const rels = await relations(zip, "ppt/presentation.xml");
  const file = zip.file("ppt/presentation.xml");
  if (!file) return [];

  const root = parseXml(await file.async("string"));
  if (!root) return [];

  const ids = children(root, P, "sldId");

  const paths: string[] = [];
  for (const id of ids) {
    const target = rels.get(id.getAttributeNS(R, "id") ?? id.getAttribute("r:id") ?? "");
    if (target) paths.push(`ppt/${target.replace(/^\.\.\//, "").replace(/^\//, "")}`);
  }
  return paths;
}

export async function parsePptx(request: ParseRequest): Promise<ParseResult> {
  const started = Date.now();
  const log: LogEntry[] = [{ label: "엔진", value: ENGINE }];
  const warnings: Warning[] = [];

  try {
    const zip = await JSZip.loadAsync(await readFile(request.filePath));
    const slides = await slideOrder(zip);

    if (slides.length === 0) {
      return {
        ok: false,
        markdown: "",
        warnings,
        log,
        meta: { engine: ENGINE, elapsedMs: Date.now() - started },
        error: { code: "NO_SLIDES", message: "슬라이드를 찾지 못했습니다.", actions: ["retry-plain"] },
      };
    }

    const lines: string[] = [];
    for (const [index, path] of slides.entries()) {
      if (request.signal?.aborted) throw new Error("변환이 취소되었습니다.");
      request.onProgress?.(index + 1, slides.length);

      const file = zip.file(path);
      if (!file) {
        warnings.push({ code: "UNSUPPORTED_ELEMENT", message: `슬라이드 파일이 없습니다: ${path}`, page: index + 1 });
        continue;
      }

      const root = parseXml(await file.async("string"));
      if (!root) {
        warnings.push({ code: "MALFORMED_XML", message: "슬라이드 XML 을 읽지 못했습니다.", page: index + 1 });
        continue;
      }

      const tree = shapeTree(root);
      if (!tree) {
        warnings.push({ code: "UNSUPPORTED_ELEMENT", message: "도형 트리가 없습니다.", page: index + 1 });
        continue;
      }

      lines.push(`<!-- Slide number: ${index + 1} -->`);
      lines.push(...renderShapes(tree, await relations(zip, path), warnings, index + 1));

      const match = /slide(\d+)\.xml$/.exec(path);
      if (match?.[1]) lines.push(...(await slideNotes(zip, Number(match[1]))));
    }

    const markdown = normalizeMarkdown(lines.join("\n"));
    const elapsedMs = Date.now() - started;

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

    return {
      ok: true,
      markdown,
      warnings,
      log: [
        ...log,
        { label: "슬라이드", value: String(slides.length) },
        { label: "경고", value: `${warnings.length}건` },
        { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` },
      ],
      meta: { pages: slides.length, engine: ENGINE, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings,
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
