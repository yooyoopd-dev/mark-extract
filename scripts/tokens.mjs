/**
 * design/index.html 의 색 토큰을 src/renderer/styles/tokens.css 로 옮긴다.
 *
 * 디자인 export 가 시각적 계약이므로 (design/README.md) 색 값은 손으로 옮기지
 * 않는다. 한 글자만 어긋나도 4단계 UI 이식에서 아무도 눈치채지 못한 채 원본과
 * 달라지기 때문이다.
 *
 *   node scripts/tokens.mjs            생성
 *   node scripts/tokens.mjs --check    대조만 하고 어긋나면 exit 1
 *
 * 반지름·타이포·모션은 원본에 CSS 변수로 존재하지 않아 생성 대상이 아니다.
 * docs/design/04-ui-spec.md 의 승격 표에 따라 base.css 에 손으로 정의한다.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "design/index.html");
const TARGET = join(root, "src/renderer/styles/tokens.css");

const BLOCKS = [
  { selector: ':root, [data-theme="light"]', label: "라이트 (기본)" },
  { selector: '[data-theme="dark"]', label: "다크" },
];

/** 선택자 바로 뒤 중괄호 블록의 `--이름: 값;` 을 순서대로 뽑는다. */
function readTokens(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`design/index.html 에 '${selector}' 블록이 없습니다`);
  const body = css.slice(at, css.indexOf("}", at));
  const pairs = [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
    name,
    value.trim(),
  ]);
  if (pairs.length === 0) throw new Error(`'${selector}' 블록에서 토큰을 찾지 못했습니다`);
  return pairs;
}

function render(css) {
  const lines = [
    "/* 자동 생성 파일 — 직접 수정하지 마세요.",
    " * 원본: design/index.html (시각적 계약)",
    " * 갱신: npm run tokens   /   검사: npm run tokens:check",
    " */",
  ];
  for (const { selector, label } of BLOCKS) {
    lines.push("", `/* ${label} */`, `${selector} {`);
    for (const [name, value] of readTokens(css, selector)) lines.push(`  ${name}: ${value};`);
    lines.push("}");
  }
  return lines.join("\n") + "\n";
}

const expected = render(readFileSync(SOURCE, "utf8"));

if (process.argv.includes("--check")) {
  if (!existsSync(TARGET)) {
    console.error("tokens.css 가 없습니다. `npm run tokens` 를 실행하세요.");
    process.exit(1);
  }
  const actual = readFileSync(TARGET, "utf8");
  if (actual === expected) {
    const count = BLOCKS.reduce((n, b) => n + readTokens(readFileSync(SOURCE, "utf8"), b.selector).length, 0);
    console.log(`토큰 ${count}개가 design/index.html 과 일치합니다.`);
    process.exit(0);
  }
  console.error("tokens.css 가 design/index.html 과 어긋납니다:\n");
  const [a, e] = [actual.split("\n"), expected.split("\n")];
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) console.error(`  ${i + 1}행\n    현재: ${a[i] ?? "(없음)"}\n    원본: ${e[i] ?? "(없음)"}`);
  }
  console.error("\n`npm run tokens` 로 다시 생성하세요.");
  process.exit(1);
}

writeFileSync(TARGET, expected);
console.log(`생성: ${TARGET.replace(root + "/", "")}`);
