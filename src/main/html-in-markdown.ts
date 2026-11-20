/**
 * 어댑터가 내놓은 Markdown 안의 HTML 조각을 Markdown 으로 되돌린다.
 *
 * 두 로컬 엔진 모두 GFM 이 허용하는 HTML 을 정당하게 내놓는다.
 *
 *   kordoc          병합 셀이나 복합 셀 내용이 있으면 <table> 로 떨어진다
 *                   (tableToMarkdown 이 tableToHtml 을 부른다)
 *   opendataloader  --markdown-with-html 을 주면 표를 <table> 로 낸다. 주지 않으면
 *                   파이프 표로 평탄화하는데, 병합된 값이 사라지고 셀 안의 |
 *                   가 이스케이프되지 않아 행이 깨진다. 그래서 HTML 로 받는다
 *
 * 둘을 같은 모양으로 받아 한 곳에서 파이프 표로 바꾼다. 병합은 GFM 으로 표현할 수
 * 없으므로 걸친 칸마다 값을 반복해 펼치고, 그 사실을 경고로 남긴다.
 *
 * normalize.ts 에 넣지 않은 이유는 joinWrappedLines 를 PDF 전용으로 떼어냈던 것과
 * 같다 — 적용 범위가 다르고, 한곳에 뭉치면 어느 포맷에 무엇이 걸리는지 알 수 없게
 * 된다.
 */
import { DOMParser } from "@xmldom/xmldom";
import type { Element as XmlElement, Node as XmlNode } from "@xmldom/xmldom";
import type { Warning } from "../shared/parse";

const parser = new DOMParser({ onError: () => {} });

/** 이름 있는 엔티티 중 두 엔진이 실제로 내놓는 것. 한 번에 한 번씩만 바꾼다. */
const ENTITY: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTML 엔티티를 원래 글자로. 한 번만 훑는다 — 두 번 돌리면 `&amp;lt;` 가
 * `<` 까지 풀려 원문에 없던 태그가 생긴다.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body.toLowerCase()] ?? whole;
  });
}

/**
 * 셀 안의 글자를 모은다.
 *
 *   <br> 엘리먼트        → "<br>" 문자열. GFM 에서 셀 안 줄바꿈을 나타내는 관례다
 *   이미 이스케이프된 것 → xmldom 이 풀어 주므로 그대로 받는다
 *
 * opendataloader 는 셀 안 줄바꿈을 `&lt;br&gt;` 로 내보내서 xmldom 이 "<br>" 라는
 * 글자로 준다. kordoc 은 진짜 <br> 엘리먼트로 낸다. 두 경우가 같은 결과가 된다.
 */
function cellText(node: XmlNode): string {
  let out = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      out += child.nodeValue ?? "";
    } else if (child.nodeType === 1) {
      const tag = (child as XmlElement).nodeName.toLowerCase();
      if (tag === "br") out += "<br>";
      else out += cellText(child);
    }
  }
  return out;
}

/** 파이프 표의 한 칸으로 넣을 수 있게 다듬는다. */
function cellForPipe(raw: string): string {
  return (
    raw
      // 셀 안의 개행은 행을 깨뜨린다. GFM 관례대로 <br> 로 바꾼다.
      .replace(/\r?\n/g, "<br>")
      // 칸 구분자로 오해되지 않게. 이미 이스케이프된 것을 두 번 하지 않는다.
      .replace(/(?<!\\)\|/g, "\\|")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const children = (node: XmlElement, names: readonly string[]): XmlElement[] => {
  const out: XmlElement[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && names.includes((child as XmlElement).nodeName.toLowerCase())) {
      out.push(child as XmlElement);
    }
  }
  return out;
};

/** <tr> 을 찾는다. <thead>/<tbody> 가 있을 수도, 없을 수도 있다. */
function rowsOf(table: XmlElement): XmlElement[] {
  const direct = children(table, ["tr"]);
  const grouped = children(table, ["thead", "tbody", "tfoot"]).flatMap((g) => children(g, ["tr"]));
  return [...grouped, ...direct].length === 0 ? [] : grouped.length > 0 ? [...grouped, ...direct] : direct;
}

const span = (cell: XmlElement, name: string): number => {
  const value = Number.parseInt(cell.getAttribute(name) ?? "1", 10);
  return Number.isFinite(value) && value > 1 ? Math.min(value, 100) : 1;
};

interface Grid {
  readonly rows: string[][];
  readonly merged: boolean;
}

/**
 * rowspan·colspan 을 격자로 펼친다. 걸친 칸에는 같은 값을 넣는다.
 *
 * GFM 파이프 표에는 병합이 없다. 빈 칸으로 두면 무엇에 속한 값인지 알 수 없어지고,
 * 값을 반복하면 적어도 각 행이 혼자서 읽힌다 (사용자 결정).
 */
function toGrid(table: XmlElement): Grid {
  const rows = rowsOf(table);
  const grid: string[][] = [];
  let merged = false;

  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of children(row, ["td", "th"])) {
      while (grid[r]![c] !== undefined) c += 1; // 위에서 내려온 rowspan 자리

      const text = cellForPipe(cellText(cell));
      const colSpan = span(cell, "colspan");
      const rowSpan = span(cell, "rowspan");
      if (colSpan > 1 || rowSpan > 1) merged = true;

      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          const target = (grid[r + dr] ??= []);
          target[c + dc] = text;
        }
      }
      c += colSpan;
    }
  });

  const width = Math.max(0, ...grid.map((row) => row.length));
  return { rows: grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? "")), merged };
}

function toPipeTable(table: XmlElement): { markdown: string; merged: boolean } | null {
  const { rows, merged } = toGrid(table);
  if (rows.length === 0 || rows[0]!.length === 0) return null;

  // GFM 은 헤더 행이 필수다. <th> 가 없으면 첫 행을 헤더로 쓴다.
  const [head, ...body] = rows;
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

  return {
    markdown: [line(head!), line(head!.map(() => "---")), ...body.map(line)].join("\n"),
    merged,
  };
}

/** ``` 울타리 밖만 손대려고 구간을 나눈다. */
function outsideFences(markdown: string): Array<{ text: string; code: boolean }> {
  const parts: Array<{ text: string; code: boolean }> = [];
  let rest = markdown;

  for (;;) {
    const open = /^ {0,3}(`{3,}|~{3,}).*$/m.exec(rest);
    if (!open) break;

    const start = open.index;
    const fence = open[1]!;
    const after = start + open[0].length;
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`, "m").exec(rest.slice(after));
    const end = close ? after + close.index + close[0].length : rest.length;

    if (start > 0) parts.push({ text: rest.slice(0, start), code: false });
    parts.push({ text: rest.slice(start, end), code: true });
    rest = rest.slice(end);
  }

  if (rest !== "") parts.push({ text: rest, code: false });
  return parts;
}

const TABLE_BLOCK = /<table[\s>][\s\S]*?<\/table\s*>/gi;

export interface Cleaned {
  readonly markdown: string;
  readonly warnings: readonly Warning[];
}

/**
 * HTML 표를 파이프 표로 바꾸고 엔티티를 되돌린다.
 *
 * 표 하나를 바꾸지 못했다고 문서 전체를 잃으면 안 되므로, 파싱에 실패하면 그 표만
 * 원본 그대로 둔다.
 */
export function cleanHtmlInMarkdown(markdown: string): Cleaned {
  let mergedAny = false;
  let failed = 0;

  const out = outsideFences(markdown)
    .map(({ text, code }) => {
      if (code) return text;

      const converted = text.replace(TABLE_BLOCK, (html) => {
        try {
          const doc = parser.parseFromString(html, "text/html");
          const table = doc.getElementsByTagName("table")[0];
          const pipe = table ? toPipeTable(table as unknown as XmlElement) : null;
          if (!pipe) {
            failed += 1;
            return html;
          }
          if (pipe.merged) mergedAny = true;
          return `\n${pipe.markdown}\n`;
        } catch {
          failed += 1;
          return html;
        }
      });

      // 표를 바꾼 뒤에 푼다. 먼저 풀면 셀 안의 &lt;td&gt; 같은 글자가 태그가 된다.
      return decodeEntities(converted);
    })
    .join("");

  const warnings: Warning[] = [];
  if (mergedAny) {
    warnings.push({
      code: "TABLE_MERGE_FLATTENED",
      message: "병합된 셀이 있는 표를 펼쳤습니다. 걸쳐 있던 값은 각 칸에 반복됩니다 — Markdown 표에는 병합이 없습니다.",
    });
  }
  if (failed > 0) {
    warnings.push({
      code: "TABLE_NOT_CONVERTED",
      message: `표 ${failed}개를 Markdown 으로 바꾸지 못해 HTML 그대로 두었습니다.`,
    });
  }

  return { markdown: out, warnings };
}
