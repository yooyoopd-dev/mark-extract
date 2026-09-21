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
const { app, BrowserWindow } = require("electron");

// 헤드리스(xvfb) 에서는 GPU 합성이 없어 capturePage() 가 UnknownVizError 로 실패한다.
// 스모크 전용 진입점이므로 여기서만 끈다 — 프로덕션 main 은 건드리지 않는다.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createMainWindow } = require("../out/main/window.js");
const { broadcastChanges, registerIpc } = require("../out/main/ipc.js");

// OCR 서버 주소를 비워 둔다. 기본값(127.0.0.1:5002)을 그대로 두면 개발 머신에서
// 서버를 띄워 둔 사람의 스모크만 다르게 돌아 — "서버 없음" 단언이 비결정적이 된다.
// 사용자가 아직 OCR 을 설정하지 않은 상태와 같다.
mkdirSync(app.getPath("userData"), { recursive: true });
writeFileSync(join(app.getPath("userData"), "settings.json"), JSON.stringify({ hybridUrl: "" }), "utf8");

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
    // 실제 앱과 같은 초기화. 창만 띄우면 IPC 가 없어 렌더러가 절반만 살고,
    // broadcastChanges() 가 없으면 큐가 진행돼도 화면이 갱신되지 않는다.
    registerIpc();
    broadcastChanges();
    const win = createMainWindow();

    // 스플래시는 본체가 그려지기까지를 덮는다. 본체보다 먼저 떠야 의미가 있고,
    // 본체가 뜬 뒤에도 남아 있으면 앱을 가린다.
    const splash = BrowserWindow.getAllWindows().find((w) => w !== win);
    if (!splash) failures.push("스플래시 창이 뜨지 않음");
    else {
      const shown = await new Promise((resolve) => {
        if (splash.isDestroyed()) return resolve(false);
        splash.once("ready-to-show", () => resolve(true));
        setTimeout(() => resolve(false), 5000);
      });
      if (!shown) failures.push("스플래시가 5초 안에 그려지지 않음");
    }

    win.webContents.on("console-message", (event) => {
      if (event.level === "error") consoleErrors.push(String(event.message ?? "").slice(0, 200));
    });
    await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

    // did-finish-load 와 ready-to-show 의 선후는 보장되지 않는다. 닫힐 때까지 본다.
    if (splash) {
      for (let i = 0; i < 50 && !splash.isDestroyed(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!splash.isDestroyed()) failures.push("본체가 떴는데 스플래시가 남아 있음");
    }

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
          var done = document.querySelectorAll("#docList .status.done").length;
          if ((cards > 0 && done === cards) || ++tries > 400) {
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
    const SURFACE = ["version", "getFilePath", "list", "markdown", "add", "onChanged", "exportMarkdown", "addWatch", "getSettings", "window"];
    const api = await win.webContents.executeJavaScript(
      `${JSON.stringify(SURFACE)}.map((k) => typeof window.markExtract?.[k]).join(',')`,
    );
    const wantApi = ["string", ...SURFACE.slice(1).map(() => "function")].join(",");
    if (api !== wantApi) failures.push(`window.markExtract 표면이 다름 (${api})`);

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

    // 상태 칩과 진행 표시. 4단계에서 클래스 이름을 .status 대신 .st 로 잘못 옮겨
    // 칩에 CSS 가 하나도 걸리지 않았고 스피너도 돌지 않았다 (build.8 실측). 이름이
    // 또 어긋나면 계산된 스타일로 잡는다.
    const chip = await win.webContents.executeJavaScript(`(() => {
      const done = document.querySelector("#docList .status.done");
      if (!done) return { error: "완료 상태 칩을 찾지 못함" };
      const s = getComputedStyle(done);
      // 변환 중 칩은 지금 없으므로 규칙 자체가 살아 있는지 본다.
      const probe = document.createElement("span");
      probe.className = "status run";
      probe.innerHTML = '<svg class="icon"></svg>';
      document.body.appendChild(probe);
      const spinner = getComputedStyle(probe.querySelector(".icon")).animationName;
      const runBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { bg: s.backgroundColor, color: s.color, spinner, runBg };
    })()`);
    if (chip.error) failures.push(chip.error);
    else {
      const transparent = (c) => c === "transparent" || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c);
      if (transparent(chip.bg)) failures.push(`완료 상태 칩에 배경색이 없음 (${chip.bg}) — .status 규칙이 걸리지 않았습니다`);
      if (transparent(chip.runBg)) failures.push(`변환중 상태 칩에 배경색이 없음 (${chip.runBg})`);
      if (chip.spinner !== "spin") failures.push(`변환중 칩 아이콘이 돌지 않음 (animation-name=${chip.spinner})`);
    }

    // 렌더링 탭에서 <br> 이 글자로 보이면 안 된다. 두 로컬 엔진 모두 표 셀 안에서
    // 이걸 내놓는다 (build.8 실측 보고 3·4). 셀 안 줄바꿈이 있는 sample-table.docx
    // 를 골라야 의미가 있다 — 단순 표만 보면 검사가 헛돈다.
    const br = await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll("#docList .doc")]
        .find((el) => (el.textContent ?? "").includes("sample-table"));
      if (!card) return { error: "sample-table 카드를 찾지 못함" };
      card.click();
      return new Promise((resolve) => setTimeout(() => {
        const article = document.querySelector("#panel .reading");
        if (!article) return resolve({ error: "렌더링 영역 없음" });
        const text = article.textContent ?? "";
        resolve({
          literal: text.includes("<br>"),
          // 표 셀이 실제로 줄바꿈으로 나뉘었는지
          breaks: article.querySelectorAll("td br, th br, br").length,
          cells: article.querySelectorAll("td").length,
          // 바꾸지 못한 HTML 표가 남으면 렌더러가 .rawtable 로 감싼다.
          raw: article.querySelectorAll(".rawtable").length,
          // 병합 표가 펼쳐졌으면 헤더가 3칸이어야 한다 (2026년 추진 계획 × 3).
          widestRow: Math.max(0, ...[...article.querySelectorAll("tr")].map((r) => r.children.length)),
          // 셀 안의 \| 는 칸 구분자가 아니다. 이걸 못 알아보면 그 행만 칸이 는다.
          escapedPipeRow: [...article.querySelectorAll("tr")]
            .filter((r) => (r.textContent ?? "").includes("파이프"))
            .map((r) => ({ cells: r.children.length, text: (r.textContent ?? "").trim() }))[0] ?? null,
        });
      }, 700));
    })()`);
    if (br.error) failures.push(br.error);
    else {
      if (br.literal) failures.push("렌더링 탭에 <br> 이 글자로 보입니다");
      if (br.breaks === 0) failures.push("표 셀 안 줄바꿈이 <br> 로 그려지지 않았습니다");
      if (br.cells === 0) failures.push("표가 그려지지 않았습니다");
      if (br.raw > 0) failures.push(`HTML 표 ${br.raw}개가 Markdown 으로 바뀌지 않았습니다`);
      if (br.widestRow < 3) failures.push(`병합 표가 펼쳐지지 않았습니다 (가장 넓은 행 ${br.widestRow}칸, 기대 3칸)`);
      if (br.escapedPipeRow === null) failures.push("파이프가 든 표 행을 찾지 못함");
      else {
        if (br.escapedPipeRow.cells !== 2) {
          failures.push(`이스케이프된 파이프가 칸을 쪼갰습니다 (${br.escapedPipeRow.cells}칸, 기대 2칸)`);
        }
        if (br.escapedPipeRow.text.includes("\\|")) failures.push("표에 \\| 가 글자로 보입니다");
      }
    }

    // 2-b. OCR 토글의 자물쇠 (7단계). hybrid 서버가 없는 상태로 도는 스모크에서는
    //      잠겨 있어야 한다 — 열려 있으면 켜 봐야 같은 실패를 보게 된다. 구조 트리는
    //      서버와 무관하므로 PDF 에서 열려 있어야 한다.
    //      앞 검사가 sample-table.docx 를 골라 둔 상태다. OCR·구조 트리는 PDF 전용이라
    //      PDF 를 다시 고르고 본다.
    const ocr = await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll("#docList .doc")]
        .find((el) => (el.textContent ?? "").includes("sample-ko.pdf"));
      if (!card) return { error: "sample-ko.pdf 카드를 찾지 못함" };
      card.click();
      return new Promise((resolve) => setTimeout(() => {
        const sw = (opt) => document.querySelector('.inspector [data-opt="' + opt + '"]');
        const ocrSw = sw("ocr");
        const stSw = sw("useStructTree");
        if (!ocrSw || !stSw) return resolve({ error: "OCR·구조 트리 토글이 인스펙터에 없습니다" });
        resolve({
          ocrDisabled: ocrSw.hasAttribute("disabled"),
          structDisabled: stSw.hasAttribute("disabled"),
          hint: (ocrSw.closest(".switchrow")?.textContent || "").includes("설정"),
          note: document.querySelectorAll(".inspector .insp-note").length,
        });
      }, 150));
    })()`);

    if (ocr.error) failures.push(ocr.error);
    else {
      if (!ocr.ocrDisabled) failures.push("서버가 없는데 OCR 토글이 열려 있습니다");
      if (!ocr.hint) failures.push("OCR 토글에 설정으로 보내는 안내가 없습니다");
      if (ocr.note !== 0) failures.push("OCR 이 꺼져 있는데 우선순위 안내가 떠 있습니다");
      // 선택한 문서가 PDF 일 때만 의미가 있다. sample-ko.pdf 가 목록에 있다.
      if (ocr.structDisabled) failures.push("PDF 인데 구조 트리 토글이 잠겨 있습니다");
    }

    // 2-c. 토글을 실제로 켜고 재변환한다 (build.25 결함).
    //
    //      잠겨 있는지만 보던 것이 이 결함을 놓쳤다 — 켠 값이 IPC 허용 목록에서
    //      버려져, 재변환을 누르는 순간 토글이 도로 꺼지고 어댑터도 인자를 받지
    //      못했다. OCR 대신 구조 트리로 보는 이유는 서버 없이 끝까지 도는
    //      경로이기 때문이고, 두 옵션은 같은 목록을 지난다.
    const toggled = await win.webContents.executeJavaScript(`(() => {
      const sw = document.querySelector('.inspector [data-opt="useStructTree"]');
      if (!sw) return Promise.resolve({ error: "구조 트리 토글이 없습니다" });
      sw.click();
      const run = document.querySelector("#inspReconvert");
      if (!run) return Promise.resolve({ error: "재변환 버튼이 없습니다" });
      run.click();

      const deadline = Date.now() + 20000;
      return new Promise((resolve) => {
        const tick = async () => {
          const docs = await window.markExtract.list();
          const doc = docs.find((d) => d.name === "sample-ko.pdf");
          if (doc && doc.status === "done") {
            const sw2 = document.querySelector('.inspector [data-opt="useStructTree"]');
            resolve({
              saved: doc.options.useStructTree === true,
              args: (doc.result?.log ?? []).find((e) => e.label === "인자")?.value ?? "",
              stillOn: sw2 ? sw2.getAttribute("aria-checked") === "true" : false,
            });
            return;
          }
          if (Date.now() > deadline) return resolve({ error: "재변환이 끝나지 않았습니다" });
          setTimeout(tick, 200);
        };
        tick();
      });
    })()`);

    if (toggled.error) failures.push(toggled.error);
    else {
      if (!toggled.saved) failures.push("켠 옵션이 문서에 저장되지 않았습니다 (IPC 가 버렸습니다)");
      if (!toggled.args.includes("--use-struct-tree")) {
        failures.push(`켠 옵션이 어댑터까지 가지 않았습니다 — ${toggled.args}`);
      }
      if (!toggled.stillOn) failures.push("재변환 뒤에 토글이 도로 꺼졌습니다");
    }

    // 2-d. 캡션바 정리 (build.25 요청). 아무 일도 하지 않던 주 메뉴를 지우고,
    //      설정을 우측 상단으로 옮겼다.
    const chrome = await win.webContents.executeJavaScript(`(() => ({
      menu: document.querySelectorAll(".tb-menu").length,
      gear: document.querySelectorAll("#sbSettings").length,
      settings: !!document.querySelector("#tbSettings"),
      label: (document.querySelector("#tbSettings")?.textContent ?? "").trim(),
      icons: document.querySelectorAll("#tbSettings svg").length,
    }))()`);

    if (chrome.menu !== 0) failures.push("캡션바에 주 메뉴가 남아 있습니다");
    if (chrome.gear !== 0) failures.push("상태바에 설정 톱니가 남아 있습니다");
    if (!chrome.settings) failures.push("캡션바에 설정 버튼이 없습니다");
    if (chrome.label !== "설정") failures.push(`설정 버튼 문구가 다릅니다: ${chrome.label}`);
    if (chrome.icons !== 0) failures.push("설정 버튼에 아이콘이 붙어 있습니다");

    // 2-e. 자체 점검 창이 실제로 스크롤되는지 (build.29 실측). 맨 .dialog 는 높이
    //      제약이 없어 본문이 내용만큼 늘어나고, 그러면 .body 의 overflow-y:auto 가
    //      걸리지 않아 화면 밖으로 넘친 뒷부분을 볼 방법이 사라진다. 사내 PC 에서
    //      kordoc 줄까지만 읽히고 그 아래를 확인할 수 없었던 것이 이것이다.
    const selfTest = await win.webContents.executeJavaScript(`(() => {
      const overlay = document.querySelector("#selfTestOverlay");
      const out = document.querySelector("#selfTestOut");
      if (!overlay || !out) return { error: "자체 점검 창 요소 없음" };
      const body = overlay.querySelector(".body");
      if (!body) return { error: "자체 점검 창 본문 칸 없음" };

      const before = out.textContent;
      out.textContent = Array.from({ length: 400 }, (_, i) => "점검 항목 " + i).join("\\n");
      overlay.hidden = false;
      body.scrollTop = 99999;
      const r = {
        overflows: body.scrollHeight > body.clientHeight + 1,
        scrolled: body.scrollTop > 0,
        dialogFits: overlay.querySelector(".dialog").getBoundingClientRect().height <= window.innerHeight + 1,
      };
      overlay.hidden = true;
      out.textContent = before;
      return r;
    })()`);

    if (selfTest.error) failures.push(selfTest.error);
    else {
      if (!selfTest.overflows) failures.push("자체 점검 창 본문이 넘치지 않음 — 칸이 내용만큼 늘어난 것으로 보입니다");
      if (!selfTest.scrolled) failures.push("자체 점검 창이 스크롤되지 않음");
      if (!selfTest.dialogFits) failures.push("자체 점검 창이 화면보다 큼 — 뒷부분을 볼 방법이 없습니다");
    }

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
