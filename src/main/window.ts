/**
 * 메인 윈도우 생성. 진입점과 분리해 둔 이유는 스모크 테스트
 * (scripts/smoke-main.cjs) 가 같은 함수를 재사용하기 위해서다 — 프로덕션 진입점에
 * 테스트 분기를 넣지 않는다.
 */
import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 520,
    minHeight: 480,
    show: false,
    backgroundColor: "#FFFFFF",
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

  win.once("ready-to-show", () => win.show());
  void win.loadFile(join(__dirname, "../renderer/index.html"));

  return win;
}
