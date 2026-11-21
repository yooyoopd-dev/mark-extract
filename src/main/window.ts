/**
 * 메인 윈도우 생성. 진입점과 분리해 둔 이유는 스모크 테스트
 * (scripts/smoke-main.cjs) 가 같은 함수를 재사용하기 위해서다 — 프로덕션 진입점에
 * 테스트 분기를 넣지 않는다.
 */
import { BrowserWindow, dialog, shell } from "electron";
import { join } from "node:path";

/**
 * 본체 창이 그려지기까지를 덮는 작은 창.
 *
 * 실측(리눅스 개발 빌드, 프로세스 시작 기준):
 *
 *   빌드 직후 첫 실행   본체 1,386ms
 *   그 뒤               스플래시 144~168ms · 본체 185~212ms
 *
 * 더운 상태에서 버는 것은 40ms 뿐이라 보이지도 않는다. 이것이 있는 이유는 첫
 * 줄 하나다 — 사용자의 첫 실행은 언제나 그 1,386ms 쪽 모양이고, 사내 PC 는
 * 백신이 갓 풀린 파일을 한 장씩 검사하므로 더 길다.
 *
 * 스타일시트 둘만 싣고 스크립트가 없어 본체보다 먼저 그려진다. 크기는 압축 해제
 * 구간을 덮는 build/splash.bmp 와 맞춰 두 구간이 이어져 보이게 했다.
 *
 * **패키징된 Windows 앱에서는 재지 못했다.** 창이 뜬 시점을 밖에서 알 방법이
 * 없어 CI 가 세지 못한다.
 */
function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 460,
    height: 260,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: "#FFFFFF",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  splash.once("ready-to-show", () => {
    // 본체가 먼저 떠 이미 닫혔을 수 있다.
    if (!splash.isDestroyed()) splash.show();
  });
  void splash.loadFile(join(__dirname, "../renderer/splash.html"));
  return splash;
}

/** 렌더러가 알려 준 저장 안 한 md 문서 수 (build.38). 편집 내용은 렌더러에만 있다. */
let unsaved = 0;
export const setUnsaved = (n: number): void => {
  unsaved = Math.max(0, Math.trunc(n));
};

/** 저장 안 한 문서가 있으면 닫기 전에 묻는다. 저장은 하지 않는다 — 앱 안에서 하고 닫는다. */
function guardClose(win: BrowserWindow): void {
  win.on("close", (event) => {
    if (unsaved === 0) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["취소", "저장하지 않고 닫기"],
      defaultId: 0,
      cancelId: 0,
      title: "Mark Extract",
      message: `저장하지 않은 Markdown 문서가 ${unsaved}개 있습니다.`,
      detail: "닫으면 고친 내용이 사라집니다.",
    });
    if (choice === 0) event.preventDefault();
    else unsaved = 0;
  });
}

export function createMainWindow(): BrowserWindow {
  const splash = createSplash();

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: "#FFFFFF",
    // 디자인이 Windows 캡션바를 직접 그린다 (design/index.html 의 .titlebar).
    // 기본 프레임을 쓰면 캡션이 둘이 된다.
    frame: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // docs/design/01-architecture.md 가 고정한 값. 완화하지 않는다.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // 앱은 원격 콘텐츠를 싣지 않는다. 문서에서 온 링크가 창을 통째로 바꾸거나
  // 새 창을 여는 일이 없도록 둘 다 막고 바깥 링크는 기본 브라우저로 넘긴다.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  guardClose(win);

  win.once("ready-to-show", () => {
    win.show();
    if (!splash.isDestroyed()) splash.destroy();
  });
  void win.loadFile(join(__dirname, "../renderer/index.html"));

  return win;
}
