/**
 * `MarkExtract.exe --self-test [파일]`
 *
 * 창을 띄우지 않고 변환 경로만 확인하고 끝난다. 이게 있어야 할 이유는 둘이다.
 *
 *  - 패키징된 앱에서만 드러나는 것이 있다. 동봉 JRE 를 찾는 경로가 개발 때와
 *    다르고, 패키징에서 제외한 의존성을 어댑터가 실제로는 쓰고 있었는지도
 *    여기서야 드러난다.
 *  - 사용자가 Windows 에서 GUI 없이 바로 확인할 수 있다.
 *
 * 인자를 주지 않으면 함께 넣어 둔 시험 자료 전부를 돌린다.
 */
import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { convert } from "./convert";
import { probe, resolveJar, resolveJava } from "./parsers/pdf-opendataloader";

const SAMPLES = ["sample-ko.pdf", "sample-ko.docx", "sample-ko.xlsx", "sample-ko.xls", "sample-ko.pptx"];

function fixturesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "fixtures") : join(app.getAppPath(), "test/fixtures");
}

export function selfTestTargets(argv: readonly string[]): string[] | null {
  const at = argv.indexOf("--self-test");
  if (at === -1) return null;

  const next = argv[at + 1];
  if (next !== undefined && !next.startsWith("--")) return [next];

  const dir = fixturesDir();
  return SAMPLES.map((name) => join(dir, name)).filter((p) => existsSync(p));
}

export async function runSelfTest(targets: readonly string[]): Promise<number> {
  const out = (label: string, value: string) => console.log(`${label.padEnd(12)} ${value}`);

  out("플랫폼", `${process.platform} ${process.arch}`);
  out("패키징", String(app.isPackaged));

  const java = resolveJava();
  out("Java", `${java.bundled ? "동봉 JRE" : "시스템 java"} — ${java.command}`);
  out("JAR", resolveJar());

  const health = await probe();
  out("엔진 확인", health.ok ? `정상 (${health.detail})` : `실패 — ${health.detail}`);
  if (!health.ok) return 1;

  if (targets.length === 0) {
    out("대상", "없음 — 시험 자료를 찾지 못했습니다.");
    return 1;
  }

  let failed = 0;
  for (const target of targets) {
    console.log(`\n--- ${target} ---`);
    const result = await convert({ filePath: target });

    if (!result.ok) {
      failed += 1;
      out("변환", `실패 — ${result.error?.message ?? "사유 없음"}`);
      for (const entry of result.log) out(`  ${entry.label}`, entry.value);
      continue;
    }

    out("엔진", result.meta.engine);
    out("변환", `성공 (${(result.meta.elapsedMs / 1000).toFixed(1)}초, 경고 ${result.warnings.length}건)`);
    console.log(
      result.markdown
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 4)
        .join("\n"),
    );
  }

  console.log(`\n${targets.length - failed}/${targets.length} 성공`);
  return failed === 0 ? 0 : 1;
}
