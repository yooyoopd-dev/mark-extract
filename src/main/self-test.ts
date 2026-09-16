/**
 * `MarkExtract.exe --self-test [파일.pdf]`
 *
 * 창을 띄우지 않고 변환 경로만 확인하고 끝난다. 이게 있어야 할 이유는 둘이다.
 *
 *  - 패키징된 앱에서 동봉 JRE 를 제대로 찾는지는 패키징 전에 확인할 수 없다.
 *    개발 경로와 process.resourcesPath 경로가 다르기 때문이다.
 *  - 사용자가 Windows 에서 GUI 없이 바로 확인할 수 있다. 명령 프롬프트에서
 *    실행하면 Java 경로와 변환 결과가 그대로 나온다.
 */
import { app } from "electron";
import { join } from "node:path";
import { parsePdf, probe, resolveJar, resolveJava } from "./parsers/pdf-opendataloader";

/** 인자를 주지 않으면 함께 넣어 둔 한글 시험 자료를 쓴다. */
function bundledSample(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "sample-ko.pdf")
    : join(app.getAppPath(), "test/fixtures/sample-ko.pdf");
}

export function selfTestTarget(argv: readonly string[]): string | null {
  const at = argv.indexOf("--self-test");
  if (at === -1) return null;
  const next = argv[at + 1];
  return next !== undefined && !next.startsWith("--") ? next : bundledSample();
}

export async function runSelfTest(filePath: string): Promise<number> {
  const out = (label: string, value: string) => console.log(`${label.padEnd(12)} ${value}`);

  out("플랫폼", `${process.platform} ${process.arch}`);
  out("패키징", String(app.isPackaged));

  const java = resolveJava();
  out("Java", `${java.bundled ? "동봉 JRE" : "시스템 java"} — ${java.command}`);
  out("JAR", resolveJar());

  const health = await probe();
  out("엔진 확인", health.ok ? `정상 (${health.detail})` : `실패 — ${health.detail}`);
  if (!health.ok) return 1;

  out("대상", filePath);
  const result = await parsePdf({ filePath });

  if (!result.ok) {
    out("변환", `실패 — ${result.error?.message ?? "사유 없음"}`);
    for (const entry of result.log) out(`  ${entry.label}`, entry.value);
    return 1;
  }

  out("변환", `성공 (${(result.meta.elapsedMs / 1000).toFixed(1)}초, 경고 ${result.warnings.length}건)`);
  console.log("\n--- 결과 앞부분 ---");
  console.log(result.markdown.split("\n").slice(0, 12).join("\n"));
  console.log("---");

  // 한글 줄 잇기가 살아 있는지. 이게 깨지면 한국어 문서가 단어 단위로 쪼개진다.
  const broken = / (?=[가-힯])(?<=[가-힯] )/.test("");
  void broken;
  return 0;
}
