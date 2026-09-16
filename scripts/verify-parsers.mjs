/**
 * 파서 어댑터 검증. 시험 자료를 변환해 단언한다.
 *
 * Electron 없이 돌린다 — 어댑터는 electron 의 app 을 경로 판정에만 쓰므로 가짜로
 * 채워 넣는다. CI 의 Windows 러너에서 한글 변환을 확인하는 것이 이 스크립트의
 * 존재 이유다.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 어댑터가 electron 의 app.isPackaged 만 본다. 개발 경로로 풀리게 해 둔다.
require.cache[require.resolve("electron")] = { exports: { app: { isPackaged: false } } };

const { convert } = require(join(root, "out/main/convert.js"));
const { probe } = require(join(root, "out/main/parsers/pdf-opendataloader.js"));
const { detectFormat } = require(join(root, "out/main/detect-format.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const fixture = (name) => join(root, "test/fixtures", name);
const outDir = join(root, "out/verify");
mkdirSync(outDir, { recursive: true });

const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-")));

/* ── 엔진 ─────────────────────────────────────────────── */
console.log("PDF 엔진 확인");
const health = await probe();
check("CLI 가 응답한다 (--export-options)", health.ok, health.detail);

/* ── 포맷 판별 ─────────────────────────────────────────── */
console.log("\n포맷 판별 (매직 바이트)");
for (const [file, want] of [
  ["sample-ko.pdf", "pdf"],
  ["sample-ko.docx", "docx"],
  ["sample-ko.xlsx", "xlsx"],
  ["sample-ko.xls", "xls"],
  ["sample-ko.pptx", "pptx"],
]) {
  const got = await detectFormat(fixture(file));
  check(`${file} → ${want}`, got === want, `실제 ${got}`);
}

// 확장자를 속여도 내용을 따라야 한다. 전용 임시 디렉터리를 써서 다른 사용자가
// 남긴 파일과 부딪히지 않게 한다.
const scratch = mkdtempSync(join(tmpdir(), "markextract-verify-"));
try {
  const misnamed = join(scratch, "실제로는-docx.pdf");
  copyFileSync(fixture("sample-ko.docx"), misnamed);
  check("확장자가 .pdf 여도 내용이 docx 면 docx", (await detectFormat(misnamed)) === "docx");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/* ── 변환 ─────────────────────────────────────────────── */
const COMMON = [
  ["제목", (md) => md.includes("문서 변환 시험 자료")],
  ["표 내용", (md) => md.includes("opendataloader-pdf") && md.includes("markitdown 규칙")],
  ["숫자·기호", (md) => md.includes("1,234,567원") && md.includes("45.6%")],
  // 시험 자료마다 곧은 따옴표와 굽은 따옴표가 섞여 있다. 어느 쪽이든 글자가
  // 온전히 넘어왔는지를 본다 — 깨지면 물음표나 사각형이 된다.
  ["따옴표 보존", (md) => /[\u201c"]인용[\u201d"]/.test(md)],
];

const CASES = [
  {
    file: "sample-ko.pdf",
    engine: "opendataloader",
    extra: [
      ["H2·H3 제목 계층", (md) => md.includes("## 1. 제목 계층") && md.includes("### 1.1 하위 절")],
      ["표 헤더", (md) => /\|\s*형식\s*\|/.test(md)],
      ["한글 줄 잇기: '섞여 있으며' 가 붙어 있다", (md) => md.includes("섞여 있으며")],
      ["한글 줄 잇기: '섞여 있 으며' 가 없다", (md) => !md.includes("섞여 있 으며")],
      ["영문 줄 잇기: 'and markdown.' 에 공백", (md) => md.includes("and markdown.")],
    ],
  },
  {
    file: "sample-ko.docx",
    engine: "kordoc",
    extra: [
      ["H2·H3 제목 계층", (md) => md.includes("## 1. 제목 계층") && md.includes("### 1.1 하위 절")],
      ["표 헤더", (md) => /\|\s*형식\s*\|/.test(md)],
    ],
  },
  {
    file: "sample-ko.xlsx",
    engine: "kordoc",
    extra: [
      ["시트가 제목이 된다", (md) => md.includes("## 변환 대상") && md.includes("## 두 번째 시트")],
      // 스프레드시트에 PDF 용 줄 잇기를 적용하면 별개 셀이 뭉개진다.
      ["별개 셀이 합쳐지지 않았다", (md) => !md.includes("본다. English and")],
    ],
  },
  {
    file: "sample-ko.xls",
    engine: "kordoc",
    extra: [["시트가 제목이 된다", (md) => md.includes("## 변환 대상")]],
  },
  {
    file: "sample-ko.pptx",
    engine: "자체 구현",
    extra: [
      ["슬라이드 경계", (md) => /<!-- Slide number: 1 -->/.test(md) && /<!-- Slide number: 3 -->/.test(md)],
      ["제목이 내용보다 먼저", (md) => md.indexOf("# 2. 표") < md.indexOf("| 형식 |")],
      ["발표자 노트", (md) => md.includes("### Notes:") && md.includes("발표자 노트다")],
      ["표", (md) => /\|\s*형식\s*\|/.test(md)],
    ],
  },
];

for (const { file, engine, extra } of CASES) {
  console.log(`\n${file}`);
  const result = await convert({ filePath: fixture(file) });

  check("변환 성공", result.ok, result.error?.message);
  if (!result.ok) {
    for (const entry of result.log) console.log(`        ${entry.label}: ${entry.value}`);
    continue;
  }

  const md = result.markdown;
  check(`엔진: ${engine}`, result.meta.engine.includes(engine), result.meta.engine);
  for (const [name, test] of [...COMMON, ...extra]) check(name, test(md));

  writeFileSync(join(outDir, file.replace(/\.[^.]+$/, "") + `.${file.split(".").pop()}.md`), md);
}

/* ── 뒷정리 ───────────────────────────────────────────── */
const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-") && !before.has(n));
console.log("\n뒷정리");
check("임시 디렉터리가 남지 않았다", leaked.length === 0, leaked.join(", "));

console.log(`\n결과 저장: out/verify/`);
if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\n파서 검증 통과");
