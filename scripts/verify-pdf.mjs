/**
 * PDF 어댑터 검증. 시험 자료를 변환해 단언한다.
 *
 * Electron 없이 돌린다 — 어댑터는 electron 의 app 을 경로 판정에만 쓰므로 가짜로
 * 채워 넣는다. CI 의 Windows 러너에서 한글 변환을 확인하는 것이 이 스크립트의
 * 존재 이유다.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 어댑터가 electron 의 app.isPackaged 만 본다. 개발 경로로 풀리게 해 둔다.
require.cache[require.resolve("electron")] = { exports: { app: { isPackaged: false } } };

const { parsePdf, probe } = require(join(root, "out/main/parsers/pdf-opendataloader.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-")));

console.log("엔진 확인");
const health = await probe();
check("CLI 가 응답한다 (--export-options)", health.ok, health.detail);
if (health.ok) console.log(`        ${health.detail}`);

console.log("\n한글 PDF 변환");
const result = await parsePdf({ filePath: join(root, "test/fixtures/sample-ko.pdf") });

check("변환 성공", result.ok, result.error?.message);
if (!result.ok) {
  for (const entry of result.log) console.log(`        ${entry.label}: ${entry.value}`);
  process.exit(1);
}

const md = result.markdown;

check("동봉 JRE 를 썼다", result.log.some((e) => e.label === "Java" && e.value.startsWith("동봉")),
  result.log.find((e) => e.label === "Java")?.value);
check("H1 제목", md.startsWith("# 문서 변환 시험 자료"));
check("H2 제목", md.includes("## 1. 제목 계층"));
check("H3 제목", md.includes("### 1.1 하위 절"));
check("표 헤더", md.includes("|형식|엔진|비고|"));
check("표 구분행", /\|[-|]+\|/.test(md));
check("표 내용", md.includes("opendataloader-pdf"));

// 이 단계의 핵심. PDF 줄바꿈에서 한글 단어가 쪼개지면 안 된다.
check("한글 줄 잇기: '섞여 있으며' 가 붙어 있다", md.includes("섞여 있으며"));
check("한글 줄 잇기: '섞여 있 으며' 가 없다", !md.includes("섞여 있 으며"));

// 영문은 반대로 공백이 있어야 한다.
check("영문 줄 잇기: 'and markdown.' 에 공백이 있다", md.includes("and markdown."));
check("영문 줄 잇기: 'andmarkdown' 이 없다", !md.includes("andmarkdown"));

check("숫자·기호", md.includes("1,234,567원") && md.includes("45.6%") && md.includes("2026-09-16"));
check("따옴표", md.includes('"인용"'));

const after = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-") && !before.has(n));
check("임시 디렉터리가 남지 않았다", after.length === 0, after.join(", "));

// CI 아티팩트로 올려 사람이 눈으로 볼 수 있게 남긴다.
const outDir = join(root, "out/verify");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "sample-ko.md"), md);
writeFileSync(
  join(outDir, "sample-ko.log.txt"),
  [
    `platform: ${process.platform} ${process.arch}`,
    ...result.log.map((e) => `${e.label}: ${e.value}`),
    `warnings: ${result.warnings.length}`,
    ...result.warnings.map((w) => `  [${w.code}] ${w.message}`),
  ].join("\n") + "\n",
);

console.log(`\n결과 저장: out/verify/sample-ko.md, out/verify/sample-ko.log.txt`);
console.log(`경고 ${result.warnings.length}건, 소요 ${(result.meta.elapsedMs / 1000).toFixed(1)}초`);

if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nPDF 검증 통과");
