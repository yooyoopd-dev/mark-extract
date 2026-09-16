/** xvfb 아래에서 Electron 을 띄워 scripts/smoke-main.cjs 의 검사를 돌린다. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = join(root, "node_modules/.bin/electron");

// 헤드리스 리눅스에서는 xvfb 로 감싼다. 디스플레이가 있으면 그대로 띄운다.
const headless = process.platform === "linux" && !process.env["DISPLAY"];
const [cmd, args] = headless
  ? ["xvfb-run", ["-a", electron, "scripts/smoke-main.cjs"]]
  : [electron, ["scripts/smoke-main.cjs"]];

if (process.platform === "linux" && process.getuid?.() === 0) {
  console.error("Chromium 은 root 로 실행되지 않습니다. 일반 사용자로 실행하세요.");
  console.error("(개발 머신에서는 해당 없음 — 컨테이너에서 root 로 돌릴 때만 나옵니다.)");
  process.exit(1);
}

const run = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
const marker = (run.stdout ?? "").split("__SMOKE__")[1];

if (!marker) {
  console.error("스모크 결과를 받지 못했습니다. Electron 이 뜨지 못한 것으로 보입니다.\n");
  console.error(run.stdout ?? "");
  console.error(run.stderr ?? "");
  process.exit(1);
}

const { failures, shots } = JSON.parse(marker.trim());

if (failures.length > 0) {
  console.error(`스모크 실패 ${failures.length}건:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("스모크 통과");
console.log("  보안 설정: nodeIntegration=false, contextIsolation=true, sandbox=true");
console.log("  색 토큰: 라이트/다크 계산값이 design/index.html 과 일치");
console.log("  preload: window.markExtract 노출 확인");
for (const s of shots) console.log(`  스크린샷: ${s}`);
