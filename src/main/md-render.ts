/**
 * md 문서의 미리보기 (build.38).
 *
 * 변환 결과의 미리보기는 렌더러의 자체 렌더러(renderer/markdown.ts)가 그린다. 그것은
 * 우리 어댑터가 내놓는 구성만 안다. 사람이 쓴 Markdown 은 중첩 목록·취소선·코드
 * 언어 같은 것이 나와서 markdown-it 을 쓴다. 렌더러에는 번들러가 없어 main 에서
 * 그리고 HTML 문자열만 보낸다.
 *
 * `html: false` — 원문 속 HTML 태그는 글자로 보인다. 렌더러는 이 문자열을 innerHTML
 * 로 넣으므로 이것이 스크립트를 막는 자리다. markdown-it 은 `javascript:` 링크도
 * 기본으로 막는다.
 */
interface Token {
  attrGet(name: string): string | null;
  content: string;
}
interface MarkdownIt {
  render(source: string): string;
  utils: { escapeHtml(text: string): string };
  renderer: { rules: Record<string, (tokens: Token[], idx: number) => string> };
}

// 타입 선언 패키지를 들이지 않으려고 require 로 받는다. 쓰는 표면은 위의 셋뿐이다.
const create = require("markdown-it") as (options: object) => MarkdownIt;

const md = create({ html: false, linkify: false, breaks: false });
const escape = md.utils.escapeHtml;

// 그림은 지금 화면과 같게 참조 라벨로 보인다. 로컬 그림을 실제로 띄우려면 CSP 의
// img-src 를 넓혀야 해서 이번에는 하지 않는다.
md.renderer.rules["image"] = (tokens, idx) => {
  const token = tokens[idx]!;
  const src = token.attrGet("src") ?? "";
  const alt = token.content;
  return (
    `<span class="imgref"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-image"/></svg>` +
    `<span>이미지 참조 · ${escape(src)}${alt ? ` — ${escape(alt)}` : ""}</span></span>`
  );
};

export const renderMd = (source: string): string => md.render(source);
