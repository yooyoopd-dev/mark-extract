/**
 * CLI 실행 파일 찾기 (docs/design/03-llm-engine.md#cli-탐색).
 *
 * Windows 는 확장자 후보를 순서대로 본다. npm 전역 설치가 `claude.cmd` 셰임을
 * 깔기 때문에 확장자 없는 이름만 찾으면 놓친다.
 *
 * 찾지 못했을 때 "설치되지 않음" 한 줄만 돌려주지 않는다. 사내망 PC 는 로그 파일을
 * 반출할 수 없어, 무엇을 어디서 어떻게 찾았는지 화면에서 읽고 옮겨 적을 수 있어야
 * 한다. 그래서 실패해도 리포트를 남긴다.
 *
 * llm-co-wiki 의 macOS 로그인 셸 PATH 탐색은 가져오지 않는다 — 제품이 Windows
 * 전용이라 필요 없는 복잡도다 (docs/design/ATTRIBUTION.md).
 */
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { isShim } from "./launch";
import type { Provider } from "../../shared/parse";

export interface Resolved {
  readonly command: string | null;
  /** 화면에 그대로 띄우는 진단. 성공·실패 모두 채운다. */
  readonly report: readonly string[];
}

/**
 * 확장자 후보. Windows 는 네이티브 실행 파일이 먼저다.
 *
 * `.cmd` 셰임은 cmd.exe 를 한 겹 거쳐야 하므로(launch.ts), 같은 프로그램이 `.exe`
 * 로도 놓여 있으면 그쪽이 낫다. 셰임이 유일한 CLI 도 있어(gemini·codex) 후보에서
 * 빼지는 않는다.
 */
function candidates(name: string): string[] {
  return process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
}

const cache = new Map<string, string>();

async function executable(path: string): Promise<boolean> {
  try {
    // Windows 는 X_OK 를 의미 있게 보지 않으므로 존재만 본다.
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH 를 직접 훑는다. which/where 를 셸로 부르지 않는다 — 셸을 거치지 않기 위해서다. */
async function search(name: string, report: string[]): Promise<string | null> {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d !== "");
  report.push(`PATH 항목 ${dirs.length}개를 훑습니다.`);

  for (const dir of dirs) {
    for (const candidate of candidates(name)) {
      const full = join(dir, candidate);
      if (await executable(full)) {
        // 사내망 PC 는 화면에 뜨는 것이 전부다. 셰임이면 왜 한 겹 더 거치는지 남긴다.
        report.push(`찾음: ${full}${isShim(full) ? " (배치 셰임 — cmd.exe 로 실행합니다)" : ""}`);
        return full;
      }
    }
  }

  report.push(`PATH 에서 ${candidates(name).join(" · ")} 를 찾지 못했습니다.`);
  return null;
}

/**
 * 캐시된 경로가 아직 살아 있는지 확인하고 돌려준다.
 *
 * CLI 를 재설치하거나 버전 관리자가 경로를 옮기면 캐시가 낡는다. 존재 확인 없이
 * 돌려주면 "있다고 했는데 실행이 안 된다"가 된다.
 */
export async function resolveCli(name: Provider | string): Promise<Resolved> {
  const report: string[] = [`대상: ${name}`, `플랫폼: ${process.platform} ${process.arch}`];

  const cached = cache.get(name);
  if (cached !== undefined) {
    if (await executable(cached)) {
      report.push(`캐시에서 찾음: ${cached}`);
      return { command: cached, report };
    }
    cache.delete(name);
    report.push(`캐시된 경로가 사라져 다시 찾습니다: ${cached}`);
  }

  const found = await search(name, report);
  if (found === null) {
    report.push("");
    report.push("확인할 것:");
    report.push(`  1) 터미널에서 ${name} 를 실행했을 때 뜨는지`);
    report.push("  2) 앱을 CLI 설치 전에 띄웠다면 앱을 다시 시작했는지 (PATH 는 시작 시 읽습니다)");
    report.push("  3) 사용자 PATH 에만 있고 시스템 PATH 에는 없는지");
    return { command: null, report };
  }

  cache.set(name, found);
  return { command: found, report };
}

/** 시험에서 캐시를 비운다. 프로덕션 경로에서는 부르지 않는다. */
export function clearCache(): void {
  cache.clear();
}
