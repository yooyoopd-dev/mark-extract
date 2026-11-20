import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window";
import { broadcastChanges, registerIpc } from "./ipc";
import { shutdown } from "./queue";
import { restoreWatches, stopAll } from "./watch";
import { runSelfTest, selfTestOutPath, selfTestTargets } from "./self-test";
import { detectOcrServer, startOcrServer, stopOcrServer } from "./ocr-server";
import { settings } from "./settings";

const selfTest = selfTestTargets(process.argv);

void app.whenReady().then(async () => {
  // --self-test 는 창을 띄우지 않고 변환 경로만 확인하고 끝낸다.
  if (selfTest !== null) {
    app.exit(await runSelfTest(selfTest, selfTestOutPath(process.argv)));
    return;
  }

  registerIpc();
  broadcastChanges();
  restoreWatches();
  createMainWindow();

  // OCR 서버: 이미 떠 있으면 그것을 쓰고, 설정이 켜져 있으면 띄운다 (build.37).
  const { hybridUrl, ocrAutoStart } = settings();
  void detectOcrServer(hybridUrl).then((s) => {
    if (s.phase !== "on" && ocrAutoStart) startOcrServer(hybridUrl);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// 돌고 있는 자바 프로세스와 앱이 띄운 OCR 서버를 남기지 않는다.
// before-quit 가 아니라 will-quit 이다 (build.38): 저장 안 한 md 가 있어 사용자가 창
// 닫기를 취소하면 종료도 취소되는데, before-quit 는 그 전에 불려 변환과 OCR 서버를
// 이미 꺼 버린다. will-quit 는 창이 모두 닫혀 정말 끝날 때만 온다.
app.on("will-quit", () => {
  stopAll();
  shutdown();
  stopOcrServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
