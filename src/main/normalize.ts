/**
 * 마크다운 후처리 (docs/design/01-architecture.md).
 *
 * 가장 중요한 일은 CJK 를 아는 줄 잇기다. opendataloader 는 PDF 의 줄바꿈에서
 * 문단을 이을 때 공백을 넣는데, 영어에서는 맞고 한글에서는 틀리다. 실측 예:
 *
 *   원문      … English가 섞여 있으며, 제목 계층과 …
 *   PDF 줄바꿈 … English가 섞여 있 / 으며, 제목 계층과 …
 *   기본 출력  … English가 섞여 있 으며, 제목 계층과 …   ← 단어 가운데 공백
 *
 * 그래서 --keep-line-breaks 로 줄 경계를 살린 채 받아 우리가 잇는다. 경계 양쪽이
 * 모두 CJK 면 공백 없이, 아니면 공백 하나로. 한글↔영문 경계는 공백이 들어가 맞다.
 *
 * --space-ratio 를 올려 고치려는 시도는 하지 말 것. 0.30 에서 원래 문제는 그대로인
 * 채 정당한 공백까지 사라진다 ("이 문서는MarkExtract의PDF어댑터를").
 */

/** 한글, 한자, 가나, 전각 문장부호. 공백 없이 붙여 쓰는 문자들. */
const CJK =
  /[ᄀ-ᇿ⺀-⻿　-〿぀-ゟ゠-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힯ힰ-퟿豈-﫿︰-﹏＀-｠]/;

/** 이어 붙이면 안 되는 줄 — 제목, 표, 인용, 코드 울타리, 목록, 수평선. */
const BLOCK = /^(\s*([-*+]|\d+[.)])\s+|#{1,6}\s|\||>|```|~~~|---+\s*$|===+\s*$)/;

const lastChar = (s: string): string => s.slice(-1);
const firstChar = (s: string): string => s.slice(0, 1);

/**
 * 문단 안에서 접힌 줄을 잇는다. 빈 줄은 문단 경계라 남기고, 블록 줄은 건드리지
 * 않는다.
 */
export function joinWrappedLines(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    const previous = out[out.length - 1];

    const canJoin =
      previous !== undefined &&
      previous.trim() !== "" &&
      line.trim() !== "" &&
      !BLOCK.test(previous) &&
      !BLOCK.test(line);

    if (!canJoin) {
      out.push(line);
      continue;
    }

    const glue = CJK.test(lastChar(previous)) && CJK.test(firstChar(line.trimStart())) ? "" : " ";
    out[out.length - 1] = previous + glue + line.trimStart();
  }

  return out.join("\n");
}

/** 어댑터가 내놓은 마크다운을 앱이 쓰는 모양으로 다듬는다. */
export function normalizeMarkdown(markdown: string): string {
  return (
    joinWrappedLines(markdown.replace(/\r\n?/g, "\n"))
      // 빈 줄이 셋 이상이면 둘로
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
