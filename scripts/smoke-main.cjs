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
const { registerIpc } = require("../out/main/ipc.js");

const ROOT = join(__dirname, "..");
const SHOTS = join(ROOT, "out/smoke");

/** 대조에 쓸 토큰. 원본에서 직접 읽으므로 기대값을 여기에 적지 않는다. */
const PROBES = ["--surface-sidebar", "--surface-app", "--text-primary", "--accent"];

/** 채운 화면을 찍기 위한 시험 자료. */
const SAMPLES = ["pdf", "docx", "xlsx", "pptx"].map((ext) => join(ROOT, `test/fixtures/sample-ko.${ext}`));

/** 로드맵 4단계가 요구하는 폭. 어느 폭에서도 가로 스크롤이 없어야 한다. */
const VIEWPORTS = [
  { name: "1920", width: 1920, height: 1080 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1366", width: 1366, height: 768 },
  { name: "1024", width: 1024, height: 768 },
];

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
  // 앱이 쓰는 실제 메커니즘 그대로 — data-theme 속성을 박는다. 테스트 전용
  // 훅을 프로덕션 코드에 두지 않기 위해서다.
  await win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`,
  );
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
    // 실제 앱과 같은 초기화. 창만 띄우면 IPC 가 없어 렌더러가 절반만 산다.
    registerIpc();
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

    // 실제 문서를 변환해 채운 상태를 본다. 앱은 argv 의 문서를 시작할 때 연다
    // (탐색기의 "연결 프로그램"과 같은 경로) — 그래서 테스트 전용 훅이 필요 없다.
    const filled = await win.webContents.executeJavaScript(`
      new Promise(function (resolve) {
        var tries = 0;
        var timer = setInterval(function () {
          var cards = document.querySelectorAll("#docList .doc").length;
          var done = document.querySelectorAll("#docList .st.done").length;
          if ((cards > 0 && done === cards) || ++tries > 100) {
            clearInterval(timer);
            resolve({ cards: cards, done: done });
          }
        }, 100);
      })`);
    if (filled.cards === 0) failures.push("명령줄로 넘긴 문서가 목록에 들어오지 않음");
    else if (filled.done !== filled.cards) {
      failures.push(`변환이 끝나지 않음 (${filled.done}/${filled.cards})`);
    }

    // 2. preload 표면과 렌더러 모듈 체인 — 테마 캡처보다 먼저 본다.
    //    모듈이 깨졌으면 여기서 정확한 사유가 나온다.
    const api = await win.webContents.executeJavaScript(
      "['version','getFilePath','pickFiles','convert','window'].map((k) => typeof window.markExtract?.[k]).join(',')",
    );
    if (api !== "string,function,function,function,function") failures.push(`window.markExtract 표면이 다름 (${api})`);

    // 렌더러 ES 모듈 체인이 실제로 실행됐는지. 여기가 비면 import 가 깨진 것이다.
    // JS 가 그리는 네 영역이 모두 채워져야 한다.
    const mounted = await win.webContents.executeJavaScript(`(() => {
      const filled = (sel) => (document.querySelector(sel)?.children.length ?? 0) > 0;
      return { nav: filled("#nav"), list: filled("#docList"), panel: filled("#panel"), insp: filled("#inspBody") };
    })()`);
    for (const [name, ok] of Object.entries(mounted)) {
      if (!ok) failures.push(`${name} 이 그려지지 않음 — 렌더러 모듈 로드 실패로 보입니다`);
    }

    // 렌더러 콘솔 오류는 조용히 지나가므로 따로 모은다.
    if (consoleErrors.length > 0) failures.push(`렌더러 콘솔 오류: ${consoleErrors.join(" | ")}`);

    // 3. 결과 영역이 실제로 스크롤되는지. 긴 문서는 한 화면에 들어오지 않는데,
    //    바깥 칸에 높이 제약이 없으면 안쪽 overflow:auto 가 걸리지 않아 뒷부분을
    //    볼 방법이 사라진다.
    const scroll = await win.webContents.executeJavaScript(`(() => {
      const scroller = document.querySelector("#panelScroll");
      const panel = document.querySelector("#panel");
      if (!scroller || !panel) return { error: "뷰어 요소 없음" };
      const before = panel.innerHTML;
      panel.innerHTML = "<p>" + Array.from({ length: 400 }, (_, i) => "긴 문서 " + i + "번째 줄").join("<br>") + "</p>";
      scroller.scrollTop = 99999;
      const r = {
        overflows: scroller.scrollHeight > scroller.clientHeight + 1,
        scrolled: scroller.scrollTop > 0,
        docFits: document.documentElement.scrollHeight <= window.innerHeight + 1,
      };
      panel.innerHTML = before;
      return r;
    })()`);
    if (scroll.error) failures.push(scroll.error);
    else {
      if (!scroll.overflows) failures.push("결과 영역이 넘치지 않음 — 칸이 내용만큼 늘어난 것으로 보입니다");
      if (!scroll.scrolled) failures.push("결과 영역이 스크롤되지 않음");
      if (!scroll.docFits) failures.push("창 자체가 넘침 — 레이아웃이 뷰포트를 벗어났습니다");
    }

    // 3. 토큰 — 실제 계산값을 원본과 대조
    for (const [theme, selector] of [["light", ':root, [data-theme="light"]'], ["dark", '[data-theme="dark"]']]) {
      const want = expectedTokens(selector);
      const got = await capture(win, theme, `shell-${theme}`);
      shots.push(join("out/smoke", `shell-${theme}.png`));
      for (const name of PROBES) {
        if (got[name] !== want[name]) failures.push(`${theme} ${name} = ${got[name]} (기대: ${want[name]})`);
      }
    }

    // 뷰포트 촬영은 라이트로. 앞의 테마 대조가 다크로 끝나기 때문이다.
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = "light"`);

    // 4. 뷰포트 — 가로 스크롤이 없어야 하고, 좁아지면 드로어로 바뀌어야 한다
    for (const vp of VIEWPORTS) {
      win.setContentSize(vp.width, vp.height);
      await new Promise((r) => setTimeout(r, 200));

      const check = await win.webContents.executeJavaScript(`(() => {
        // 두 가지를 나눠 본다.
        //
        // 1) 스크롤을 막는 기전이 살아 있는가. 디자인은 body 의 overflow:hidden
        //    으로 막는다. 루트의 computed overflow 를 보면 안 된다 — 뷰포트로
        //    전파된 값이 아니라 지정값을 돌려주기 때문에 항상 visible 이다.
        // 2) 화면을 벗어나는 요소가 있는가. 닫힌 드로어는 일부러 밖에 있으므로
        //    (translateX(102%)) 드로어와 그 자손은 뺀다.
        var bodyOverflow = getComputedStyle(document.body).overflowX;
        var userScrollable = ["visible", "auto", "scroll"].indexOf(bodyOverflow) !== -1;

        var drawers = [".sidebar", ".inspector"]
          .map(function (sel) { return document.querySelector(sel); })
          .filter(function (el) { return el && getComputedStyle(el).position === "absolute"; });

        var w = window.innerWidth;
        var escapes = Array.prototype.slice.call(document.querySelectorAll("body *"))
          .filter(function (el) {
            return !drawers.some(function (d) { return d === el || d.contains(el); });
          })
          .filter(function (el) {
            var r = el.getBoundingClientRect();
            return r.width > 0 && r.right > w + 1;
          })
          .slice(0, 3)
          .map(function (el) { return el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""); });

        return {
          userScrollable: userScrollable,
          escapes: escapes,
          cols: getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length,
          inspectorDrawer: getComputedStyle(document.querySelector(".inspector")).position === "absolute",
          sidebarDrawer: getComputedStyle(document.querySelector(".sidebar")).position === "absolute"
        };
      })()`);

      if (check.userScrollable) failures.push(`${vp.name}px 에서 body 가 가로 스크롤을 허용함`);
      if (check.escapes.length > 0) {
        failures.push(`${vp.name}px 에서 화면을 벗어난 요소: ${check.escapes.join(", ")}`);
      }

      // 1200 이하에서 인스펙터가, 1024 이하에서 사이드바가 드로어가 된다.
      if (vp.width <= 1200 && !check.inspectorDrawer) failures.push(`${vp.name}px 에서 인스펙터가 드로어로 바뀌지 않음`);
      if (vp.width > 1200 && check.inspectorDrawer) failures.push(`${vp.name}px 에서 인스펙터가 드로어가 되면 안 됨`);
      if (vp.width <= 1024 && !check.sidebarDrawer) failures.push(`${vp.name}px 에서 사이드바가 드로어로 바뀌지 않음`);

      const image = await win.webContents.capturePage();
      writeFileSync(join(SHOTS, `w${vp.name}.png`), image.toPNG());
      shots.push(join("out/smoke", `w${vp.name}.png`));
    }
  } catch (error) {
    failures.push(`예외: ${error && error.stack ? error.stack : String(error)}`);
  }

  process.stdout.write("\n__SMOKE__" + JSON.stringify({ failures, shots }) + "\n");
  app.exit(failures.length === 0 ? 0 : 1);
});
