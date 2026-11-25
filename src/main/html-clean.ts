/**
 * HTML 을 turndown 에 넘기기 전에 정리한다 (build.39).
 *
 * 메일·웹 HTML 은 글자 말고도 화면을 짜는 장치를 잔뜩 품고 있다. 그대로 넘기면
 *
 *   - 배치용 표가 데이터 표로 읽혀 본문 전체가 칸 하나에 뭉치고, 안에 표가 또 있으면
 *     표 변환이 실패해 **HTML 코드가 그대로** 남는다 (사용자 보고, 재현함)
 *   - 메일 미리보기용 숨김 문구, 추적용 1px 그림, Outlook 조건부 주석이 섞인다
 *
 * 그래서 여기서 문서를 한 번 다듬는다. 기준은 Mozilla Readability(Firefox 읽기 모드,
 * Apache-2.0)의 두 판정을 따랐다 — 코드는 옮기지 않고 규칙만 다시 썼다.
 *
 *   숨김    `_isProbablyVisible`: display:none · visibility:hidden · hidden 속성 ·
 *           aria-hidden="true". 여기에 Outlook 의 mso-hide:all 을 더했다
 *   표      `_markDataTables`: 아래 isDataTable 의 순서 그대로다. **한 군데를 바꿨다** —
 *           Readability 는 th 등을 안쪽 표까지 뒤져 찾는다. 그러면 바깥 배치 표가 안쪽
 *           데이터 표 때문에 "데이터 표" 가 된다. 메일에서는 그것이 바로 문제의 모양이라
 *           그 표 자신의 칸만 본다
 *
 * 파서는 turndown 이 이미 쓰는 domino 다. 새 의존성이 아니다.
 */
// 타입 선언이 없어 require 로 받는다. 쓰는 것은 createDocument 하나다.
const domino = require("@mixmark-io/domino") as { createDocument(html: string): unknown };

/** domino 노드 중 우리가 쓰는 것만. */
interface El {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly parentNode: El | null;
  readonly childNodes: ArrayLike<El>;
  readonly firstChild: El | null;
  nodeValue: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<El>;
  appendChild(node: El): El;
  insertBefore(node: El, ref: El): El;
  replaceWith(node: El): void;
  remove(): void;
}
interface Doc extends El {
  createElement(name: string): El;
}

const TEXT = 3;
const COMMENT = 8;

/** 글자가 아닌 것. 내용째 지운다. */
const DROP = "head,script,style,noscript,template,iframe,object,embed,svg,canvas,xml,input,select,textarea";
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i;
/** 폭 없는 글자. 메일 미리보기 문구가 줄 채우기에 쓴다. */
const ZERO_WIDTH = /[​-‍⁠﻿­͏]/g;
/** 이보다 작은 그림은 추적 픽셀이나 간격용이다. */
const TINY_PX = 2;

const all = (root: El, selector: string): El[] => Array.from(root.querySelectorAll(selector));

function walk(node: El, visit: (n: El) => void): void {
  for (const child of Array.from(node.childNodes)) {
    visit(child);
    walk(child, visit);
  }
}

function hidden(el: El): boolean {
  return (
    el.hasAttribute("hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    HIDDEN_STYLE.test(el.getAttribute("style") ?? "")
  );
}

function tiny(img: El): boolean {
  const px = (name: string): number => Number.parseInt(img.getAttribute(name) ?? "", 10);
  return px("width") <= TINY_PX || px("height") <= TINY_PX;
}

/** 가장 가까운 바깥 표. 안쪽 표의 행·칸을 바깥 표 것으로 세지 않으려고 쓴다. */
function ownerTable(el: El): El | null {
  for (let p = el.parentNode; p; p = p.parentNode) if (p.nodeName === "TABLE") return p;
  return null;
}

const own = (table: El, selector: string): El[] => all(table, selector).filter((el) => ownerTable(el) === table);

const span = (el: El, name: string): number => Math.max(1, Number.parseInt(el.getAttribute(name) ?? "1", 10) || 1);

/** Readability `_markDataTables` 의 순서. 바꾼 것은 "그 표 자신의" 칸만 보는 것 하나다. */
export function isDataTable(table: El): boolean {
  const role = table.getAttribute("role");
  if (role === "presentation" || role === "none" || table.getAttribute("datatable") === "0") return false;
  if ((table.getAttribute("summary") ?? "").trim() !== "") return true;
  if (own(table, "caption").some((c) => c.childNodes.length > 0)) return true;
  if (own(table, "col,colgroup,tfoot,thead,th").length > 0) return true;
  if (all(table, "table").length > 0) return false;

  const rows = own(table, "tr");
  const rowCount = rows.reduce((n, tr) => n + span(tr, "rowspan"), 0);
  const columns = Math.max(0, ...rows.map((tr) => own(table, "td").filter((td) => td.parentNode === tr).reduce((n, td) => n + span(td, "colspan"), 0)));
  if (rowCount <= 1 || columns <= 1) return false;
  if (rowCount >= 10 || columns > 4) return true;
  return rowCount * columns > 10;
}

/** 배치 표를 칸마다 블록으로 푼다. 글자 순서는 원문 그대로다. */
function unwrap(doc: Doc, table: El): void {
  const box = doc.createElement("div");
  for (const cell of own(table, "td,th")) {
    const block = doc.createElement("div");
    while (cell.firstChild) block.appendChild(cell.firstChild);
    box.appendChild(block);
  }
  table.replaceWith(box);
}

/** 정리한 문서. turndown 에 그대로 넘긴다. */
export function cleanHtml(html: string): Doc {
  const doc = domino.createDocument(html) as unknown as Doc;

  for (const el of all(doc, DROP)) el.remove();

  const comments: El[] = [];
  walk(doc, (n) => {
    if (n.nodeType === COMMENT) comments.push(n);
  });
  for (const c of comments) c.remove();

  // Outlook 의 접두사 태그. VML 그림(v:*)은 지우고, o:p 같은 나머지는 껍데기만 벗긴다.
  for (const el of all(doc, "*")) {
    if (!el.nodeName.includes(":") || !el.parentNode) continue;
    if (el.nodeName.startsWith("V:")) el.remove();
    else {
      while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
      el.remove();
    }
  }

  for (const el of all(doc, "*")) if (el.parentNode && hidden(el)) el.remove();
  for (const img of all(doc, "img")) if (tiny(img)) img.remove();

  // 판정을 먼저 끝내고 푼다. 풀면서 판정하면 안쪽 표가 "안에 표가 있음" 을 잃는다.
  const layout = all(doc, "table").filter((t) => !isDataTable(t));
  for (const table of layout) unwrap(doc, table);

  walk(doc, (n) => {
    if (n.nodeType === TEXT && n.nodeValue) n.nodeValue = n.nodeValue.replace(ZERO_WIDTH, "");
  });
  return doc;
}
