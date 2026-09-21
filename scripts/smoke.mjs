/** xvfb 아래에서 Electron 을 띄워 scripts/smoke-main.cjs 의 검사를 돌린다. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = join(root, "node_modules/.bin/electron");

// 헤드리스 리눅스에서는 xvfb 로 감싼다. 디스플레이가 있으면 그대로 띄운다.
// 빈 화면이 아니라 실제로 채운 UI 를 검증한다. 앱은 argv 의 문서를 시작할 때 연다.
// sample-table.docx 를 함께 연다. 셀 안 <br> 과 병합 표가 있는 유일한 자료라서,
// 이것이 없으면 "<br> 이 글자로 보이지 않는다" 검사가 헛돈다.
const samples = [
  ...["pdf", "docx", "xlsx", "pptx"].map((ext) => join(root, `test/fixtures/sample-ko.${ext}`)),
  join(root, "test/fixtures/sample-table.docx"),
];
const entry = ["scripts/smoke-main.cjs", ...samples];

const headless = process.platform === "linux" && !process.env["DISPLAY"];
const [cmd, args] = headless ? ["xvfb-run", ["-a", electron, ...entry]] : [electron, entry];

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
console.log("  스플래시: 본체보다 먼저 그려지고 본체가 뜨면 닫힘");
console.log("  보안 설정: nodeIntegration=false, contextIsolation=true, sandbox=true");
console.log("  색 토큰: 라이트/다크 계산값이 design/index.html 과 일치");
console.log("  preload: window.markExtract 표면 확인 (목록·본문·추가·구독·내보내기·감시·설정)");
console.log("  렌더러: 사이드바·목록·뷰어·인스펙터가 모두 그려짐, 콘솔 오류 없음");
console.log("  변환: 시험 자료 4종이 UI 를 통해 변환되어 목록에 완료로 표시됨");
console.log("  스크롤: 뷰어가 넘치고 스크롤됨, 창은 뷰포트 안");
console.log("  반응형: 1920·1440·1366·1024 에서 넘침 없음, 드로어 전환 정상");
for (const s of shots) console.log(`  스크린샷: ${s}`);
