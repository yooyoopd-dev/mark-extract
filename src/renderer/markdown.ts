/**
 * 최소 마크다운 렌더러. design/index.html 에서 옮겼다.
 *
 * 라이브러리를 들이지 않는 이유는 우리가 렌더할 대상이 우리 어댑터가 만든
 * 마크다운뿐이라서다. 어떤 구성요소가 나오는지 알고 있고, 임의의 사용자 입력을
 * 렌더하지 않는다. 그래도 값은 전부 이스케이프한다.
 */

/** SVG 심볼 참조. index.html 의 <symbol> 을 가리킨다. */
export const icon = (name: string, cls = "icon"): string =>
  `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;

export const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(text: string): string {
  return (
    esc(text)
      // 이미지는 깨진 그림 대신 참조를 라벨로 보인다 (원본과 같은 방식).
      // 우리 어댑터는 이미지를 파일 참조로만 내놓고 아직 꺼내 두지 않는다.
      .replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_m, alt: string, src: string) =>
          `<span class="imgref">${icon("i-image", "icon icon-sm")}<span>이미지 참조 · ${src}${alt ? ` — ${alt}` : ""}</span></span>`,
      )
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      // GFM 에서 표 셀 안의 줄바꿈은 <br> 로 쓴다. 두 로컬 엔진 모두 이걸 내놓고,
      // 어댑터도 셀 안 개행을 <br> 로 바꾼다 (html-in-markdown.ts). esc() 로
      // 막아 두면 사용자에게 "<br>" 이라는 글자가 그대로 보인다 — build.8 실측에서
      // 보고된 증상이다. 되살리는 것은 이 하나뿐이고 나머지 태그는 글자로 둔다.
      .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
  );
}

/**
 * 표의 한 행을 칸으로 나눈다.
 *
 * `\|` 는 셀 안의 파이프이지 칸 구분자가 아니다. 그냥 split("|") 하면 그런 행이
 * 칸 수가 더 많아져 표가 어긋난다 — 우리 어댑터가 셀 안의 파이프를 이스케이프해
 * 내보내므로(html-in-markdown.ts) 실제로 일어난다.
 */
const cells = (row: string): string[] =>
  row
    .replace(/^\||(?<!\\)\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

const isBlock = (line: string): boolean =>
  /^(#{1,6}\s|>|```|\||\s*[-*]\s|\s*\d+\.\s|---+\s*$)/.test(line);

/** 마크다운을 HTML 로. 렌더링 탭이 쓴다. */
export function renderMarkdown(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // 프론트매터와 수평선
    if (/^---+\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      i += 1;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) buf.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }

    if (/^\|/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|/.test(lines[i] ?? "")) rows.push(lines[i++] ?? "");
      const head = cells(rows[0] ?? "");
      const body = rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] ?? "") ? 2 : 1);
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${body
            .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        buf.push((lines[i++] ?? "").replace(/^\s*[-*]\s+/, ""));
      }
      out.push(`<ul>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        buf.push((lines[i++] ?? "").replace(/^\s*\d+\.\s+/, ""));
      }
      out.push(`<ol>${buf.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // HTML 주석(PPTX 의 슬라이드 경계)은 그대로 흘려보내지 않고 구분선으로 보인다.
    const comment = /^<!--\s*(.+?)\s*-->$/.exec(line);
    if (comment?.[1]) {
      out.push(`<p class="reading-note">${esc(comment[1])}</p>`);
      i += 1;
      continue;
    }

    // 바꾸지 못한 HTML 표. 태그를 글자로 흘리는 대신 무슨 일이 있었는지 알린다.
    if (/^\s*<table[\s>]/i.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && !/<\/table\s*>/i.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      if (i < lines.length) buf.push(lines[i++] ?? "");
      out.push(
        `<div class="rawtable">${icon("i-alert", "icon icon-sm")}` +
          `<span>표를 Markdown 으로 바꾸지 못했습니다. 원본 HTML 을 그대로 보입니다.</span>` +
          `<pre><code>${esc(buf.join("\n"))}</code></pre></div>`,
      );
      continue;
    }

    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !isBlock(lines[i] ?? "")) buf.push(lines[i++] ?? "");
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  return out.join("\n");
}

/** 원본 Markdown 탭의 구문 강조. */
export function highlightMarkdown(source: string): string {
  return esc(source)
    .replace(/^(---)$/gm, '<span class="tk-f">$1</span>')
    .replace(/^(#{1,6} .*)$/gm, '<span class="tk-h">$1</span>')
    .replace(/^(&gt; .*)$/gm, '<span class="tk-q">$1</span>')
    .replace(/^(\|.*)$/gm, '<span class="tk-t">$1</span>')
    .replace(/^(\s*[-*] |\s*\d+\. )/gm, '<span class="tk-m">$1</span>')
    .replace(/(\*\*[^*\n]+\*\*)/g, '<span class="tk-b">$1</span>')
    .replace(/(`[^`\n]+`)/g, '<span class="tk-c">$1</span>');
}
