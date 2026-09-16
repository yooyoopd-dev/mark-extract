import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { broadcastChanges, registerIpc } from "./ipc";
import { shutdown } from "./queue";
import { restoreWatches, stopAll } from "./watch";
import { runSelfTest, selfTestTargets } from "./self-test";

const selfTest = selfTestTargets(process.argv);

void app.whenReady().then(async () => {
  // --self-test 는 창을 띄우지 않고 변환 경로만 확인하고 끝낸다.
  if (selfTest !== null) {
    app.exit(await runSelfTest(selfTest));
    return;
  }

  registerIpc();
  broadcastChanges();
  restoreWatches();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// 돌고 있는 자바 프로세스를 남기지 않는다.
app.on("before-quit", () => {
  stopAll();
  shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
