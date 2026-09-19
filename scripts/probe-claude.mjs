/**
 * 진짜 claude CLI 로 한 번 돌려 본다.
 *
 * 가짜 하니스(test/fake-cli/)는 우리 코드를 검증하지만, 진짜 CLI 가 그 형식대로
 * 말하는지는 알려 주지 못한다. 이 스크립트가 그 한 가지를 확인한다.
 *
 * CI 에는 넣지 않는다 — 러너에 CLI 인증이 없다. 사람이 손으로 돌린다.
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-probe-"));
mkdirSync(join(work, "userData"), { recursive: true });
require.cache[require.resolve("electron")] = {
  exports: { app: { isPackaged: false, getPath: () => join(work, "userData") } },
};

const { parseWithLlm } = require(join(root, "out/main/llm/run.js"));
const { convert } = require(join(root, "out/main/convert.js"));

const target = process.argv[2] ?? join(root, "test/fixtures/sample-ko.docx");
const mode = process.argv[3] ?? "B";

console.log(`대상: ${target}`);
console.log(`모드: ${mode}`);

const result = await parseWithLlm(
  { filePath: target, options: { engine: "llm", provider: "claude", inputMode: mode } },
  convert,
);

for (const entry of result.log) console.log(`  ${entry.label.padEnd(10)} ${entry.value.slice(0, 300)}`);
console.log(`\nok: ${result.ok}`);
if (!result.ok) {
  console.log(`오류: [${result.error?.code}] ${result.error?.message}`);
} else {
  console.log(`길이: ${result.markdown.length}자`);
  console.log("--- 앞부분 ---");
  console.log(result.markdown.slice(0, 600));
}
rmSync(work, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
