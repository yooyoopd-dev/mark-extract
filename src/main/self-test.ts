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
 *
 * 8단계에서 환경 점검을 더했다. 검증 스크립트 여섯 판은 Node 와 저장소가 있어야
 * 돌기 때문에, 사내 PC 에서 확인할 수 있는 것은 여기 적히는 것이 전부다.
 */
import { app } from "electron";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convert } from "./convert";
import { probe, resolveJar, resolveJava } from "./parsers/pdf-opendataloader";
import { testHybrid } from "./hybrid-http";
import { probeCli } from "./llm/launch";
import { resolveCli } from "./llm/resolve";
import { PROVIDERS } from "./llm/providers";
import { settings } from "./settings";

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

type Out = (label: string, value: string) => void;

/**
 * 변환 말고, **패키징된 앱에서만 드러나는 것들**을 훑는다.
 *
 * 종료 코드에는 넣지 않는다. LLM CLI 와 OCR 서버는 사용자가 따로 깔고 띄우는
 * 것이라 없는 것이 정상이고, 그것으로 패키징이 실패했다고 말하면 안 된다.
 */
async function environment(out: Out): Promise<void> {
  // portable 실행이라도 설정과 이력은 %APPDATA% 에 남는다. 그 경로가 막힌 PC 를
  // 여기서 가려낸다 — 막혀 있으면 설정이 매번 기본값으로 돌아간다.
  const dir = app.getPath("userData");
  try {
    const probeFile = join(dir, ".self-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(probeFile, "ok", "utf8");
    unlinkSync(probeFile);
    out("설정 경로", `${dir} (쓰기 가능)`);
  } catch (error) {
    out("설정 경로", `${dir} — 쓰지 못했습니다: ${(error as Error).message}`);
  }

  // 찾는 것과 도는 것은 다른 사실이다 (build.10 의 spawn EINVAL).
  const lines = await Promise.all(
    (Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map(async (id) => {
      const { command } = await resolveCli(id);
      if (command === null) return [`LLM · ${id}`, "찾지 못했습니다"] as const;
      const cli = await probeCli(command);
      return [`LLM · ${id}`, `${cli.ok ? "실행됨" : "실행하지 못했습니다"} — ${cli.detail} (${command})`] as const;
    }),
  );
  for (const [label, value] of lines) out(label, value);

  const url = settings().hybridUrl;
  if (url === "") {
    out("OCR 서버", "주소 없음 — OCR 을 쓰지 않습니다.");
    return;
  }
  const hybrid = await testHybrid(url);
  out("OCR 서버", hybrid.ok ? `정상 (${url}, ${hybrid.ms}ms)` : `닿지 않습니다 (${url}) — ${hybrid.detail}`);
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

  console.log("");
  await environment(out);

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
