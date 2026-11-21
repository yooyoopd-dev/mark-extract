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
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
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
  // build.36: 768 이하의 한 칸 전환은 한 번도 재지 않았고, 그 사이 목록과 뷰어가
  // 위아래로 함께 나오고 있었다.
  { name: "700", width: 700, height: 800 },
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
          // 이미지 PDF 는 "OCR 필요"(.status.warn) 로 끝난다 — 그것도 끝난 것이다.
          var done = document.querySelectorAll("#docList .status.done, #docList .status.warn").length;
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

    // HTML·EML (build.34). 명령줄 → 큐 → 어댑터를 지나 완료됐는지, 그리고 형식 배지에
    // 색이 걸리는지 — 배지는 인스펙터에만 있어 같은 클래스의 요소를 잠깐 만들어 본다.
    const kinds = await win.webContents.executeJavaScript(`(async () => {
      const docs = await window.markExtract.list();
      const badge = (k) => {
        const el = document.createElement("span");
        el.className = "fmt " + k;
        document.body.appendChild(el);
        const bg = getComputedStyle(el).backgroundColor;
        el.remove();
        return bg;
      };
      return ["html", "eml"].map((k) => ({ k, status: docs.find((d) => d.kind === k)?.status ?? "없음", bg: badge(k) }));
    })()`);
    for (const k of kinds) {
      if (k.status !== "done") failures.push(`${k.k} 문서가 완료되지 않음 (${k.status})`);
      if (k.bg === "rgba(0, 0, 0, 0)" || k.bg === "") failures.push(`.fmt.${k.k} 에 색이 걸리지 않음`);
    }

    // 2. preload 표면과 렌더러 모듈 체인 — 테마 캡처보다 먼저 본다.
    //    모듈이 깨졌으면 여기서 정확한 사유가 나온다.
    const SURFACE = ["version", "getFilePath", "list", "markdown", "add", "onChanged", "exportMarkdown", "addWatch", "getSettings", "window", "newMd", "saveMd", "saveMdAs", "renderMd", "setUnsaved"];
    const api = await win.webContents.executeJavaScript(
      `${JSON.stringify(SURFACE)}.map((k) => typeof window.markExtract?.[k]).join(',')`,
    );
    const wantApi = ["string", ...SURFACE.slice(1).map(() => "function")].join(",");
    if (api !== wantApi) failures.push(`window.markExtract 표면이 다름 (${api})`);

    // 렌더러 ES 모듈 체인이 실제로 실행됐는지. 여기가 비면 import 가 깨진 것이다.
    // JS 가 그리는 세 영역이 모두 채워져야 한다 (build.36 에서 사이드바를 걷어 냈다).
    const mounted = await win.webContents.executeJavaScript(`(() => {
      const filled = (sel) => (document.querySelector(sel)?.children.length ?? 0) > 0;
      return { list: filled("#docList"), panel: filled("#panel"), insp: filled("#inspBody") };
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
          hint: (ocrSw.closest(".switchrow")?.textContent || "").includes("자동으로 켭니다"),
          note: document.querySelectorAll(".inspector .insp-note").length,
        });
      }, 150));
    })()`);

    if (ocr.error) failures.push(ocr.error);
    else {
      // build.37: 서버가 꺼져 있어도 켤 수 있다 — 재변환할 때 앱이 서버를 띄운다.
      if (ocr.ocrDisabled) failures.push("서버가 꺼져 있다고 OCR 토글이 잠겨 있습니다");
      if (!ocr.hint) failures.push("OCR 토글에 '자동으로 켭니다' 안내가 없습니다");
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

    // 2-d. 화면 정리 (build.36 요청). 뺀 것이 정말 빠졌는지, 남긴 것이 제자리에
    //      있는지. 캡션바의 [설정] 은 build.25 에 글자만 두었는데, 이번 요청에서
    //      "세팅 아이콘이 이상하다" 는 지적을 받아 톱니를 다시 그려 붙였다.
    const chrome = await win.webContents.executeJavaScript(`(() => {
      const gone = ["#nav", ".sidebar", ".statusbar", "#paletteOverlay", "#paletteOpen", "#themeToggle", "#starBtn", "#navToggle"]
        .filter((sel) => document.querySelector(sel));
      const gear = document.querySelector("#i-gear path");
      const box = gear ? gear.getBBox() : null;
      return {
        gone,
        settings: (document.querySelector("#tbSettings")?.textContent ?? "").trim(),
        settingsIcon: document.querySelector("#tbSettings use")?.getAttribute("href") ?? "",
        add: !!document.querySelector(".titlebar #addFile"),
        // 톱니 경로가 viewBox(24) 를 꽉 채우는지. 전의 경로는 손으로 이은 곡선이 어긋나 있었다.
        gearBox: box ? [box.x, box.y, box.width, box.height].map((n) => Math.round(n * 10) / 10) : null,
        chips: [...document.querySelectorAll(".chips .chip")].map((c) => c.dataset.status),
        allCount: document.querySelector('.chip [data-count="all"]')?.textContent ?? "",
        cards: document.querySelectorAll("#docList .doc").length,
        snippets: document.querySelectorAll("#docList .doc-snip").length,
      };
    })()`);

    if (chrome.gone.length > 0) failures.push(`뺀 것이 남아 있습니다: ${chrome.gone.join(", ")}`);
    if (chrome.settings !== "설정") failures.push(`설정 버튼 문구가 다릅니다: ${chrome.settings}`);
    if (chrome.settingsIcon !== "#i-gear") failures.push(`설정 버튼에 톱니가 없습니다: ${chrome.settingsIcon}`);
    if (!chrome.add) failures.push("캡션바에 [파일 추가] 가 없습니다");
    if (!chrome.gearBox || chrome.gearBox[2] < 18 || chrome.gearBox[3] < 18) {
      failures.push(`톱니 경로가 viewBox 를 채우지 않습니다: ${JSON.stringify(chrome.gearBox)}`);
    }
    // 상태 보기는 칩 하나로 모였다. 대기·변환 중은 "진행 중" 하나다.
    if (chrome.chips.join(",") !== "all,active,done,failed") failures.push(`상태 칩이 다릅니다: ${chrome.chips.join(",")}`);
    if (chrome.allCount !== String(chrome.cards)) failures.push(`전체 칩 숫자(${chrome.allCount})가 카드 수(${chrome.cards})와 다릅니다`);
    if (chrome.snippets !== 0) failures.push("목록 카드에 미리보기 두 줄이 남아 있습니다");

    // 2-d'. 변환 옵션 패널은 기본 닫힘이고 [옵션] 으로 연다. 넓은 창에서는 세 번째 칸이다.
    win.setContentSize(1440, 900);
    await new Promise((r) => setTimeout(r, 200));
    const panelState = await win.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 120));
      const insp = document.querySelector(".inspector");
      const cols = () => getComputedStyle(document.querySelector(".workspace")).gridTemplateColumns.split(" ").length;
      const r = { closedHidden: getComputedStyle(insp).display === "none", closedCols: cols() };
      document.querySelector("#inspectorToggle").click();
      await wait();
      r.openShown = getComputedStyle(insp).display !== "none";
      r.openCols = cols();
      r.pressed = document.querySelector("#inspectorToggle").getAttribute("aria-pressed");
      return r;
    })()`);
    if (!panelState.closedHidden) failures.push("변환 옵션 패널이 처음부터 열려 있습니다");
    if (panelState.closedCols !== 2) failures.push(`닫힌 상태의 칸 수가 ${panelState.closedCols} 입니다 (기대 2)`);
    if (!panelState.openShown) failures.push("[옵션] 을 눌러도 패널이 열리지 않습니다");
    if (panelState.openCols !== 3) failures.push(`열린 상태의 칸 수가 ${panelState.openCols} 입니다 (기대 3)`);
    if (panelState.pressed !== "true") failures.push("[옵션] 버튼이 눌린 상태로 표시되지 않습니다");
    const optionsShot = await win.webContents.capturePage();
    writeFileSync(join(SHOTS, "w1440-options.png"), optionsShot.toPNG());
    shots.push(join("out/smoke", "w1440-options.png"));
    await win.webContents.executeJavaScript(`document.querySelector("#inspectorToggle").click()`);

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

    // 2-f. 설정 → OCR 절 (build.37 에서 다시 짰다). 상태와 버튼 하나. [연결 테스트] ·
    //      터미널 [실행] · "새 PDF 에 OCR 켜 두기" 는 없어야 한다. 켜기를 누르지는 않는다 —
    //      러너에 서버가 없고, 누르면 띄우려 한다.
    const ocrPane = await win.webContents.executeJavaScript(`(async () => {
      const wait = () => new Promise((r) => setTimeout(r, 200));
      document.querySelector("#tbSettings")?.click();
      await wait();
      document.querySelector('.settings-tabs .tab[data-pane="ocr"]')?.click();
      await wait();
      const r = {
        gone: ["#testHybrid", "#startOcrServer", "#ocrByDefault"].filter((s) => document.querySelector(s)),
        start: (document.querySelector("#ocrStart")?.textContent ?? "").trim(),
        auto: !!document.querySelector("#ocrAutoStart"),
        state: (document.querySelector("#settingsBody .cli-row")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        command: (document.querySelector("#ocrRun")?.textContent ?? "").trim(),
      };
      // 직접 구동 명령의 포트가 설정 주소를 따르는지.
      await window.markExtract.setSettings({ hybridUrl: "http://127.0.0.1:7111" });
      document.querySelector("#tbSettings").click();
      await wait();
      r.moved = (document.querySelector("#ocrRun")?.textContent ?? "").trim();
      await window.markExtract.setSettings({ hybridUrl: "" });
      document.querySelector("#settingsOverlay").hidden = true;
      return r;
    })()`);

    if (ocrPane.gone.length > 0) failures.push(`설정 OCR 절에 없어야 할 것이 있습니다: ${ocrPane.gone.join(", ")}`);
    if (!ocrPane.start.includes("OCR 서버 켜기")) failures.push(`OCR 서버 켜기 버튼이 없습니다: ${ocrPane.start}`);
    if (!ocrPane.auto) failures.push("'앱을 켤 때 OCR 서버도 켜기' 가 없습니다");
    if (!ocrPane.state.includes("꺼져 있습니다")) failures.push(`OCR 상태 줄이 다릅니다: ${ocrPane.state}`);
    if (!ocrPane.command.includes("--host 127.0.0.1") || !ocrPane.command.includes("--port 5002")) {
      failures.push(`직접 구동 명령이 다릅니다: ${ocrPane.command}`);
    }
    if (!ocrPane.moved?.includes("--port 7111")) failures.push(`구동 명령의 포트가 주소를 따르지 않습니다: ${ocrPane.moved}`);

    // 2-g. 이미지로 된 PDF (build.37). 빨간 실패가 아니라 "OCR 필요" 와 [OCR 로 변환].
    const scan = await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll("#docList .doc")].find((el) => (el.textContent ?? "").includes("sample-scan"));
      if (!card) return Promise.resolve({ error: "sample-scan 카드를 찾지 못함" });
      const chip = card.querySelector(".status");
      const r = { chipClass: chip?.className ?? "", chipText: (chip?.textContent ?? "").trim() };
      card.click();
      return new Promise((resolve) => setTimeout(() => {
        r.box = !!document.querySelector("#panel .ocrbox");
        r.failbox = !!document.querySelector("#panel .failbox");
        r.button = (document.querySelector('#panel [data-retry="retry-with-ocr"]')?.textContent ?? "").trim();
        resolve(r);
      }, 300));
    })()`);
    if (scan.error) failures.push(scan.error);
    else {
      if (!scan.chipClass.includes("warn") || scan.chipText !== "OCR 필요") failures.push(`이미지 PDF 카드가 다릅니다: ${scan.chipClass} / ${scan.chipText}`);
      if (scan.failbox || !scan.box) failures.push("이미지 PDF 가 빨간 실패 상자로 그려집니다");
      if (!scan.button.includes("OCR 로 변환")) failures.push(`[OCR 로 변환] 버튼이 없습니다: ${scan.button}`);
    }

    // 2-h. Markdown 열기·편집·저장 (build.38). CRLF 파일을 열어 한 줄 더하고 Ctrl+S.
    //      목록이 다시 그려져도 편집 영역(커서·값)이 그대로인지가 요점이다.
    // markextract- 로 시작하면 verify-queue 의 "어댑터 임시 디렉터리가 남지 않았다" 에 걸린다.
    const mdDir = mkdtempSync(join(tmpdir(), "smoke-md-"));
    const mdPath = join(mdDir, "메모.md");
    writeFileSync(mdPath, "# 메모\r\n\r\n첫 줄\r\n");
    const edit = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
      window.confirm = () => true;
      await window.markExtract.add([${JSON.stringify(mdPath)}]);
      await wait();
      const find = () => [...document.querySelectorAll("#docList .doc")].find((el) => (el.textContent ?? "").includes("메모.md"));
      if (!find()) return { error: "md 카드가 목록에 없음" };
      find().click();
      await wait();
      const r = {
        meta: (find()?.querySelector(".doc-meta")?.textContent ?? "").trim(),
        status: (find()?.querySelector(".status")?.textContent ?? "").trim(),
        preview: (document.querySelector("#panel h1")?.textContent ?? "").trim(),
        // hidden 속성이 아니라 실제로 가려졌는지 본다. .tab · .tb-tool 의 display 규칙이
        // [hidden] 을 덮어 속성은 붙었는데 화면에 남은 일이 있었다 (build.38 스크린샷).
        logHidden: getComputedStyle(document.querySelector("#tab-log")).display === "none",
        optHidden: getComputedStyle(document.querySelector("#inspectorToggle")).display === "none",
      };
      document.querySelector("#tab-source").click();
      await wait();
      const ta = document.querySelector("#editText");
      r.tabLabel = document.querySelector("#tab-source").textContent.trim();
      r.editorShown = !document.querySelector("#editor").hidden && document.querySelector("#panelScroll").hidden;
      r.loaded = ta.value;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      document.execCommand("insertText", false, "둘째 줄\\n");
      await wait(400);
      r.dot = !!document.querySelector("#docList .unsaved") && !!document.querySelector("#crumbs .unsaved");
      r.side = document.querySelector("#editPreview")?.textContent ?? "";
      // 커서를 가운데 둔다. 끝에 두면 value 를 다시 넣어도(커서가 끝으로 감) 차이가 안 난다.
      ta.setSelectionRange(3, 3);
      const caret = ta.selectionStart;
      document.querySelector('.chip[data-status="all"]').click();
      await wait();
      r.kept = document.querySelector("#editText") === ta && ta.selectionStart === caret && ta.value.endsWith("둘째 줄\\n");
      ta.setSelectionRange(ta.value.length, ta.value.length);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }));
      await wait(700);
      r.dotAfter = !!document.querySelector("#docList .unsaved");
      r.valueAfter = ta.value;

      // 새 문서: 편집 탭으로 열리고, 고친 뒤 제거하면 ● 가 사라진다.
      document.querySelector("#newMd").click();
      await wait(400);
      r.newCrumb = (document.querySelector("#crumbs .cur")?.textContent ?? "").trim();
      r.newEditing = !document.querySelector("#editor").hidden && ta.value === "";
      document.execCommand("insertText", false, "새 글");
      await wait();
      r.newDot = !!document.querySelector("#docList .unsaved");
      document.querySelector("#deleteBtn").click();
      await wait(400);
      r.cleared = !document.querySelector("#docList .unsaved");
      return r;
    })()`);
    if (edit.error) failures.push(edit.error);
    else {
      if (!edit.meta.startsWith("MD") || edit.status !== "완료") failures.push(`md 카드가 다릅니다: ${edit.meta} / ${edit.status}`);
      if (edit.preview !== "메모") failures.push(`md 미리보기 제목이 다릅니다: ${edit.preview}`);
      if (!edit.logHidden || !edit.optHidden) failures.push("md 문서에 변환 로그 탭·옵션 버튼이 보입니다");
      if (edit.tabLabel !== "편집") failures.push(`md 의 둘째 탭 이름이 다릅니다: ${edit.tabLabel}`);
      if (!edit.editorShown) failures.push("편집 탭에서 편집 영역이 보이지 않습니다");
      if (edit.loaded !== "# 메모\n\n첫 줄\n") failures.push(`편집 영역에 실린 본문이 다릅니다: ${JSON.stringify(edit.loaded)}`);
      if (!edit.dot) failures.push("고친 뒤 ● (저장 안 함) 표시가 없습니다");
      if (!edit.side.includes("둘째 줄")) failures.push(`옆 미리보기가 고친 내용을 따라가지 않습니다: ${edit.side}`);
      if (!edit.kept) failures.push("목록을 다시 그리자 편집 영역의 값이나 커서가 바뀌었습니다");
      if (edit.dotAfter) failures.push("Ctrl+S 뒤에도 ● 가 남아 있습니다");
      if (!edit.valueAfter.endsWith("둘째 줄\n")) failures.push("저장 뒤 편집 영역 값이 바뀌었습니다");
      const onDisk = readFileSync(mdPath, "utf8");
      rmSync(mdDir, { recursive: true, force: true });
      if (onDisk !== "# 메모\r\n\r\n첫 줄\r\n둘째 줄\r\n") failures.push(`저장된 파일이 다릅니다 (CRLF 유지): ${JSON.stringify(onDisk)}`);
      if (edit.newCrumb !== "제목 없음.md" || !edit.newEditing) failures.push(`새 문서가 빈 편집 탭으로 열리지 않습니다: ${edit.newCrumb}`);
      if (!edit.newDot) failures.push("새 문서에 쓴 뒤 ● 가 없습니다");
      if (!edit.cleared) failures.push("고친 새 문서를 제거했는데 ● 가 남았습니다");
    }
    // 편집 화면(원문 | 미리보기) 한 장. 그 뒤 미리보기 탭으로 되돌린다 — 뒤의 스크롤
    // 검사는 #panelScroll 을 쓰는데 편집 탭이면 가려져 있다.
    await win.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll("#docList .doc")].find((el) => (el.textContent ?? "").includes("메모.md"));
      card?.click();
      document.querySelector("#tab-source").click();
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(SHOTS, "w1440-editor.png"), (await win.webContents.capturePage()).toPNG());
    shots.push(join("out/smoke", "w1440-editor.png"));
    await win.webContents.executeJavaScript(`document.querySelector("#tab-render").click()`);

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

        var drawers = [".inspector"]
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
          // 목록 안쪽이 목록 칸을 밀고 나가는가 (build.36: 1024 에서 14px 넘쳤다).
          shownPanes: [".listpane", ".viewer"].filter(function (sel) {
            return getComputedStyle(document.querySelector(sel)).display !== "none";
          }).length,
          listOverflow: Math.round(document.querySelector("#docList").getBoundingClientRect().right
            - document.querySelector(".listpane").getBoundingClientRect().right)
        };
      })()`);

      if (check.userScrollable) failures.push(`${vp.name}px 에서 body 가 가로 스크롤을 허용함`);
      if (check.escapes.length > 0) {
        failures.push(`${vp.name}px 에서 화면을 벗어난 요소: ${check.escapes.join(", ")}`);
      }

      // 1200 이하에서 변환 옵션 패널이 덮는 드로어가 된다. 사이드바는 build.36 에서 없앴다.
      if (vp.width <= 1200 && !check.inspectorDrawer) failures.push(`${vp.name}px 에서 인스펙터가 드로어로 바뀌지 않음`);
      if (vp.width > 1200 && check.inspectorDrawer) failures.push(`${vp.name}px 에서 인스펙터가 드로어가 되면 안 됨`);
      if (check.listOverflow > 0) failures.push(`${vp.name}px 에서 목록이 칸을 ${check.listOverflow}px 넘침`);
      if (vp.width <= 768 && check.shownPanes !== 1) failures.push(`${vp.name}px 에서 목록·뷰어가 ${check.shownPanes}개 함께 보임 (기대 1)`);

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
