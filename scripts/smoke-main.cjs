/**
 * 스모크 테스트 전용 Electron 진입점.
 *
 * 프로덕션 main(out/main/index.js)에 테스트 분기를 넣지 않으려고 따로 둔다.
 * createMainWindow() 는 같은 것을 쓰므로 실제 창을 검사하는 셈이다.
 *
 * 확인 항목
 *   1. webPreferences 가 docs/design/01-architecture.md 대로 잠겼는지
 *   2. 라이트/다크에서 계산된 색 토큰이 design/index.html 과 같은지
 *   3. 두 테마 스크린샷 저장 (사람 확인용)
 *
 * 결과는 JSON 한 줄로 stdout 에 내보낸다. scripts/smoke.mjs 가 읽는다.
 */
const { app } = require("electron");

// 헤드리스(xvfb) 에서는 GPU 합성이 없어 capturePage() 가 UnknownVizError 로 실패한다.
// 스모크 전용 진입점이므로 여기서만 끈다 — 프로덕션 main 은 건드리지 않는다.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createMainWindow } = require("../out/main/window.js");

const ROOT = join(__dirname, "..");
const SHOTS = join(ROOT, "out/smoke");

/** 대조에 쓸 토큰. 원본에서 직접 읽으므로 기대값을 여기에 적지 않는다. */
const PROBES = ["--surface-sidebar", "--surface-app", "--text-primary", "--accent"];

function expectedTokens(selector) {
  const css = readFileSync(join(ROOT, "design/index.html"), "utf8");
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(at, css.indexOf("}", at));
  const found = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (PROBES.includes(name)) found[name] = value.trim();
  }
  return found;
}

const readProbes = `(${PROBES.length}, (() => {
  const s = getComputedStyle(document.documentElement);
  const out = {};
  for (const n of ${JSON.stringify(PROBES)}) out[n] = s.getPropertyValue(n).trim();
  return out;
})())`;

async function capture(win, theme, name) {
  await win.webContents.executeJavaScript(`window.setTheme(${JSON.stringify(theme)})`);
  // 스타일 재계산과 페인트가 끝난 뒤 읽어야 한다.
  await new Promise((r) => setTimeout(r, 150));
  const tokens = await win.webContents.executeJavaScript(readProbes);
  const image = await win.webContents.capturePage();
  writeFileSync(join(SHOTS, `${name}.png`), image.toPNG());
  return tokens;
}

app.whenReady().then(async () => {
  const failures = [];
  const consoleErrors = [];
  let shots = [];

  try {
    mkdirSync(SHOTS, { recursive: true });
    const win = createMainWindow();
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") consoleErrors.push(String(event.message ?? "").slice(0, 200));
    });
    await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

    // 1. 보안 설정 — 소스 grep 이 아니라 실행 중인 webContents 에서 읽는다.
    const prefs = win.webContents.getLastWebPreferences() ?? {};
    for (const [key, want] of [["nodeIntegration", false], ["contextIsolation", true], ["sandbox", true]]) {
      if (prefs[key] !== want) failures.push(`webPreferences.${key} = ${prefs[key]} (기대: ${want})`);
    }

    // 2. preload 표면과 렌더러 모듈 체인 — 테마 캡처보다 먼저 본다.
    //    모듈이 깨졌으면 여기서 정확한 사유가 나온다.
    const api = await win.webContents.executeJavaScript(
      "[typeof window.markExtract?.version, typeof window.markExtract?.convert, typeof window.markExtract?.getFilePath].join(',')",
    );
    if (api !== "string,function,function") failures.push(`window.markExtract 표면이 다름 (${api})`);

    // 렌더러 ES 모듈 체인이 실제로 실행됐는지. 여기가 비면 import 가 깨진 것이다.
    const mounted = await win.webContents.executeJavaScript("!!document.querySelector('#dbgDrop')");
    if (mounted !== true) failures.push("디버그 뷰가 붙지 않음 — 렌더러 모듈 로드 실패로 보입니다");

    // 렌더러 콘솔 오류는 조용히 지나가므로 따로 모은다.
    if (consoleErrors.length > 0) failures.push(`렌더러 콘솔 오류: ${consoleErrors.join(" | ")}`);

    // 3. 토큰 — 실제 계산값을 원본과 대조
    for (const [theme, selector] of [["light", ':root, [data-theme="light"]'], ["dark", '[data-theme="dark"]']]) {
      const want = expectedTokens(selector);
      const got = await capture(win, theme, `shell-${theme}`);
      shots.push(join("out/smoke", `shell-${theme}.png`));
      for (const name of PROBES) {
        if (got[name] !== want[name]) failures.push(`${theme} ${name} = ${got[name]} (기대: ${want[name]})`);
      }
    }

  } catch (error) {
    failures.push(`예외: ${error && error.stack ? error.stack : String(error)}`);
  }

  process.stdout.write("\n__SMOKE__" + JSON.stringify({ failures, shots }) + "\n");
  app.exit(failures.length === 0 ? 0 : 1);
});
