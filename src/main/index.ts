import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { registerIpc } from "./ipc";
import { runSelfTest, selfTestTarget } from "./self-test";

const selfTest = selfTestTarget(process.argv);

void app.whenReady().then(async () => {
  // --self-test 는 창을 띄우지 않고 변환 경로만 확인하고 끝낸다.
  if (selfTest !== null) {
    app.exit(await runSelfTest(selfTest));
    return;
  }

  registerIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
