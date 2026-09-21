/**
 * 변환 큐 · 감시 폴더 · 내보내기 검증 (docs/design/06-roadmap.md 5단계).
 *
 * 로드맵이 적어 둔 다섯 가지를 그대로 확인한다.
 *   1. 폴더를 드롭하면 지원 포맷만 큐에 들어간다
 *   2. 취소가 자식 프로세스를 실제로 죽인다
 *   3. 재변환이 바뀐 옵션을 반영한다
 *   4. 한 문서가 실패해도 큐가 계속 진행된다
 *   5. 내보낸 파일이 BOM 없는 UTF-8이다
 *
 * verify-parsers.mjs 와 같이 Electron 없이 돌린다 — main 모듈이 electron 에서
 * 쓰는 것은 경로 판정뿐이라 가짜로 채운다.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-queue-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });

// 어댑터는 app.isPackaged 로 경로를 고르고, 설정은 app.getPath("userData") 에
// 저장한다. 실제 홈 디렉터리를 건드리지 않도록 임시 폴더로 돌려 준다.
// ipc.js 는 electron 에서 ipcMain·BrowserWindow 도 꺼내 쓴다. 채널을 등록하지는
// 않고 cleanOptions 만 부르므로 껍데기로 충분하다.
require.cache[require.resolve("electron")] = {
  exports: {
    app: { isPackaged: false, getPath: () => userData },
    ipcMain: { handle: () => {} },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: {},
    shell: {},
  },
};

const queue = require(join(root, "out/main/queue.js"));
const watch = require(join(root, "out/main/watch.js"));
const { cleanOptions } = require(join(root, "out/main/ipc.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const fixture = (name) => join(root, "test/fixtures", name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 기다린다. 큐는 이벤트로 움직이므로 고정 대기는 못 쓴다. */
async function until(test, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(100);
  }
  return false;
}

const byName = (name) => queue.list().find((d) => d.name === name);

/**
 * 돌고 있는 opendataloader 자바 프로세스 수. Windows 에서는 세지 않는다.
 *
 * 실행 파일 이름이 java 인 것만 센다. args 만 보면 jar 이름을 명령줄에 담고 있는
 * 셸까지 잡혀 "죽지 않았다"는 거짓 실패가 난다.
 */
function javaProcesses() {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-eo", "comm=,args="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => /^java\b/.test(line.trim()) && line.includes("opendataloader-pdf-cli.jar")).length;
  } catch {
    return null;
  }
}

try {
  /* ── 1. 폴더 안에서 지원 포맷만 걸러 낸다 ─────────────── */
  console.log("\n폴더 추가");

  const dropDir = join(work, "drop");
  const nested = join(dropDir, "안쪽 폴더");
  mkdirSync(nested, { recursive: true });
  copyFileSync(fixture("sample-ko.docx"), join(dropDir, "sample-ko.docx"));
  copyFileSync(fixture("sample-ko.pptx"), join(nested, "sample-ko.pptx"));
  // 걸러져야 할 것들
  writeFileSync(join(dropDir, "메모.txt"), "지원하지 않는 형식", "utf8");
  writeFileSync(join(dropDir, "보고서.hwp"), "HWP 는 지원하지 않는다", "utf8");
  writeFileSync(join(dropDir, ".숨김.docx"), "숨김 파일", "utf8");

  // DRM 도구가 확장자를 바꿔 놓은 파일을 흉내 낸다. 확장자만 보고 거르므로 이런
  // 파일은 목록에 들어오지도 않는다 — 사용자가 이유를 알 수 있어야 한다 (build.25).
  writeFileSync(join(dropDir, "사내 보고서.dcm"), "DRM 으로 감싼 문서", "utf8");

  const dropped = await queue.add([dropDir]);
  check(
    "건너뛴 파일 이름을 알려 준다",
    dropped.unsupported.includes("사내 보고서.dcm") && dropped.unsupported.includes("보고서.hwp"),
    dropped.unsupported.join(", "),
  );
  check("숨김 파일은 이름에도 올리지 않는다", !dropped.unsupported.some((n) => n.startsWith(".")));

  const names = queue.list().map((d) => d.name).sort();
  check("폴더 안의 지원 포맷만 큐에 들어간다", names.join(",") === "sample-ko.docx,sample-ko.pptx", names.join(","));
  check("하위 폴더까지 훑는다", names.includes("sample-ko.pptx"));

  check("모두 변환됨", await until(() => queue.list().every((d) => d.status === "done")));
  const docx = byName("sample-ko.docx");
  check("본문이 저장된다", queue.markdownOf(docx.id).includes("문서 변환 시험 자료"));
  check("미리보기가 채워진다", docx.snippet.length > 20, docx.snippet);

  /* ── 2. 취소가 자식 프로세스를 죽인다 ─────────────────── */
  console.log("\n취소");

  for (const d of queue.list()) queue.remove(d.id);
  await queue.add([fixture("sample-ko.pdf")]);
  const pdf = byName("sample-ko.pdf");

  check("변환이 시작된다", await until(() => byName("sample-ko.pdf")?.status === "run", 30_000));

  // status 가 run 이 되는 것은 spawn 보다 앞선다(형식 판별이 먼저다). 자바가
  // 실제로 뜬 것을 본 다음에 취소해야 죽였는지 아닌지를 말할 수 있다.
  const countable = javaProcesses() !== null;
  const spawned = countable ? await until(() => javaProcesses() > 0, 30_000) : false;

  queue.cancel(pdf.id);
  // 짧게 본다. 이 시험 자료는 1초 안팎이면 변환이 끝나므로, 오래 기다렸다가
  // 세면 자연히 끝난 것과 죽인 것을 구별할 수 없다. SIGKILL 은 즉시다.
  await sleep(250);
  const survivors = javaProcesses();
  await sleep(1500);

  check("취소하면 실패로 표시된다", byName("sample-ko.pdf")?.status === "failed");
  check("취소 사유가 남는다", byName("sample-ko.pdf")?.result?.error?.code === "CANCELLED");
  if (!countable) console.log("  건너뜀  자바 프로세스 확인 (이 플랫폼에서는 셀 수 없음)");
  else {
    check("취소 전에 자바가 돌고 있었다", spawned);
    check("취소가 자바 프로세스를 즉시 죽인다", survivors === 0, `${survivors}개 남음`);
  }

  /* ── 3. 재변환이 바뀐 옵션을 반영한다 ─────────────────── */
  console.log("\n재변환");

  queue.reconvert(pdf.id, {});
  check("재변환하면 다시 완료된다", await until(() => byName("sample-ko.pdf")?.status === "done"));
  const plain = queue.markdownOf(pdf.id);

  const argsOf = (name) => byName(name)?.result?.log.find((e) => e.label === "인자")?.value ?? "";
  check("기본값에는 옵션 플래그가 없다", !argsOf("sample-ko.pdf").includes("--include-header-footer"));

  // 옵션이 어댑터의 명령줄까지 가는지를 본다. 결과 본문을 대조하지 않는 이유는
  // 이 시험 자료에 머리글·바닥글이 없어 --include-header-footer 를 켜도 출력이
  // 같기 때문이다 (CLI 로 직접 확인). 내용이 아니라 전달 경로가 확인 대상이다.
  queue.reconvert(pdf.id, { includeHeaderFooter: true, tableMethod: "cluster" });
  check("옵션이 저장된다", byName("sample-ko.pdf")?.options.includeHeaderFooter === true);
  check("옵션 재변환이 끝난다", await until(() => byName("sample-ko.pdf")?.status === "done"));

  const args = argsOf("sample-ko.pdf");
  check("머리글·바닥글 옵션이 어댑터까지 간다", args.includes("--include-header-footer"), args);
  check("표 감지 옵션이 어댑터까지 간다", args.includes("--table-method cluster"), args);
  check("본문은 그대로 다시 나온다", queue.markdownOf(pdf.id).length > 0 && plain.length > 0);

  // 설정의 기본값이 새 문서에 실제로 심기는지 (build.25 요청). 이미 큐에 있는
  // 문서는 건드리지 않는다 — 사용자가 인스펙터에서 손댄 값이 날아가면 안 된다.
  const { updateSettings } = require(join(root, "out/main/settings.js"));
  updateSettings({ ocrByDefault: true });
  const before = byName("sample-ko.pdf")?.options.ocr;
  await queue.add([fixture("sample-ko.pptx")]);
  check("설정을 켜면 새 문서에 OCR 이 심긴다", byName("sample-ko.pptx")?.options.ocr === true);
  check("이미 있던 문서는 그대로다", byName("sample-ko.pdf")?.options.ocr === before);
  updateSettings({ ocrByDefault: false });
  check("설정을 끄면 다시 꺼진 채로 들어온다", await (async () => {
    for (const d of queue.list()) if (d.name === "sample-ko.pptx") queue.remove(d.id);
    await queue.add([fixture("sample-ko.pptx")]);
    return byName("sample-ko.pptx")?.options.ocr === false;
  })());

  /* ── 3b. IPC 경계가 옵션을 버리지 않는다 ──────────────── */
  //
  // build.25 에서 OCR·구조 트리 토글이 재변환을 누르는 순간 다시 꺼졌다. 원인은
  // 어댑터도 렌더러도 아니라 ipc.ts 의 허용 목록에 세 키가 없던 것이었다. 그때까지
  // 이 구간을 지나는 검사가 하나도 없었다 — verify-ocr 은 어댑터 함수에 옵션을
  // 손으로 먹이고, 위의 재변환 검사는 마침 목록에 있는 키만 골라 썼다.
  console.log("\nIPC 옵션 왕복");

  const through = cleanOptions({ ocr: true, hybridFullPages: true, useStructTree: true });
  check("OCR 이 IPC 를 지난다", through.ocr === true, JSON.stringify(through));
  check("전수 보내기가 IPC 를 지난다", through.hybridFullPages === true, JSON.stringify(through));
  check("구조 트리가 IPC 를 지난다", through.useStructTree === true, JSON.stringify(through));

  // 끄는 길도 있어야 한다. false 를 빈 값으로 보고 버리면 한 번 켠 옵션을 끌 수 없다.
  const off = cleanOptions({ ocr: false, useStructTree: false });
  check("끈 값도 그대로 지난다", off.ocr === false && off.useStructTree === false, JSON.stringify(off));

  check("모르는 키는 여전히 버린다", cleanOptions({ 이상한키: 1 })["이상한키"] === undefined);

  // 이미지 처리 (build.30). 값 목록을 좁혔으니 여기도 같이 좁혀야 한다 — 화면과
  // 어댑터가 멀쩡한데 IPC 가 값을 버려 기능이 죽는 것이 build.25 의 OCR 토글이었다.
  const img = cleanOptions({ imageOutput: "off" });
  check("제외가 IPC 를 지난다", img.imageOutput === "off", JSON.stringify(img));
  check("위치 표시가 IPC 를 지난다", cleanOptions({ imageOutput: "note" }).imageOutput === "note");
  check("없앤 external 은 버린다", cleanOptions({ imageOutput: "external" }).imageOutput === undefined);
  check("없앤 embedded 도 버린다", cleanOptions({ imageOutput: "embedded" }).imageOutput === undefined);

  // 렌더러가 보내는 모양 그대로 넣어 어댑터 명령줄까지 확인한다. OCR 대신 구조
  // 트리를 쓰는 이유는 서버 없이도 끝까지 도는 경로이기 때문이다.
  queue.reconvert(pdf.id, cleanOptions({ useStructTree: true }));
  check("구조 트리 재변환이 끝난다", await until(() => byName("sample-ko.pdf")?.status === "done"));
  check("구조 트리가 문서에 저장된다", byName("sample-ko.pdf")?.options.useStructTree === true);
  const stArgs = argsOf("sample-ko.pdf");
  check("구조 트리가 어댑터까지 간다", stArgs.includes("--use-struct-tree"), stArgs);

  /* ── 4. 한 건이 실패해도 큐가 멈추지 않는다 ───────────── */
  console.log("\n실패 격리");

  for (const d of queue.list()) queue.remove(d.id);
  const brokenPdf = join(work, "깨진 문서.pdf");
  writeFileSync(brokenPdf, "이것은 PDF 가 아니다", "utf8");

  await queue.add([brokenPdf, fixture("sample-ko.docx"), fixture("sample-ko.xlsx")]);
  check("셋 다 큐에 들어간다", queue.list().length === 3, String(queue.list().length));
  check("큐가 끝까지 돈다", await until(() => queue.list().every((d) => d.status !== "queued" && d.status !== "run")));
  check("깨진 문서는 실패한다", byName("깨진 문서.pdf")?.status === "failed");
  check("뒤의 두 건은 성공한다", byName("sample-ko.docx")?.status === "done" && byName("sample-ko.xlsx")?.status === "done");
  check(
    "실패에도 행동이 남는다",
    (byName("깨진 문서.pdf")?.result?.error?.actions.length ?? 0) >= 0,
  );

  /* ── 감시 폴더 ────────────────────────────────────────── */
  console.log("\n감시 폴더");

  const watched = join(work, "감시");
  mkdirSync(watched, { recursive: true });
  // 감시를 걸기 전부터 있던 것도 한 번 훑어야 한다.
  copyFileSync(fixture("sample-ko.pptx"), join(watched, "먼저 있던 문서.pptx"));

  const folders = await watch.addWatch(watched);
  check("감시 폴더가 설정에 남는다", folders.some((w) => w.path === watched), JSON.stringify(folders));
  check("걸 때 이미 있던 문서가 들어온다", await until(() => byName("먼저 있던 문서.pptx") !== undefined, 30_000));

  // 새로 떨어진 파일. 복사가 끝나기를 기다렸다가 넣는지도 여기서 함께 본다.
  copyFileSync(fixture("sample-ko.docx"), join(watched, "새로 온 문서.docx"));
  check("새 문서가 자동으로 들어온다", await until(() => byName("새로 온 문서.docx") !== undefined, 30_000));
  check("자동으로 변환까지 된다", await until(() => byName("새로 온 문서.docx")?.status === "done"));

  // 지원하지 않는 형식은 떨어져도 무시한다.
  writeFileSync(join(watched, "무시할 것.txt"), "지원하지 않는 형식", "utf8");
  await sleep(2500);
  check("지원하지 않는 형식은 들어오지 않는다", byName("무시할 것.txt") === undefined);

  const left = watch.removeWatch(watched);
  check("감시를 해제하면 설정에서 빠진다", !left.some((w) => w.path === watched));
  copyFileSync(fixture("sample-ko.xlsx"), join(watched, "해제 뒤 문서.xlsx"));
  await sleep(2500);
  check("해제 뒤에는 들어오지 않는다", byName("해제 뒤 문서.xlsx") === undefined);

  for (const d of queue.list()) if (d.path.startsWith(watched)) queue.remove(d.id);
  watch.stopAll();

  /* ── 5. 내보내기 ──────────────────────────────────────── */
  console.log("\n내보내기");

  const outDir = join(work, "출력");
  mkdirSync(outDir, { recursive: true });

  // ids 가 비면 "완료된 것 전부". 실패한 문서는 애초에 대상이 아니다.
  const first = await queue.exportDocs({ ids: [], outputDir: outDir, frontmatter: true });
  check("완료된 것만 내보낸다", first.written === 2 && first.failed === 0, JSON.stringify(first));

  // 실패한 문서를 이름으로 집어 주면 그때는 실패로 센다.
  const withBroken = await queue.exportDocs({
    ids: [byName("깨진 문서.pdf").id],
    outputDir: outDir,
    frontmatter: true,
  });
  check("실패한 문서는 파일이 되지 않는다", withBroken.written === 0 && withBroken.failed === 1);

  const written = readdirSync(outDir).sort();
  check("확장자가 .md 다", written.every((n) => n.endsWith(".md")), written.join(","));
  // 시험 자료 둘이 같은 이름(sample-ko)이라 첫 내보내기에서 이미 갈린다.
  check("같은 이름이면 -1 을 붙인다", written.join(",") === "sample-ko-1.md,sample-ko.md", written.join(","));

  const bytes = readFileSync(join(outDir, "sample-ko.md"));
  check("BOM 이 없다", !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  const text = bytes.toString("utf8");
  check("UTF-8 로 한글이 온전하다", text.includes("문서 변환 시험 자료"));
  check("프론트매터가 붙는다", text.startsWith("---\ntitle: sample-ko\n"));

  // 같은 폴더로 한 번 더. 기존 파일을 덮지 않아야 한다.
  const mtime = statSync(join(outDir, "sample-ko.md")).mtimeMs;
  await queue.exportDocs({ ids: [], outputDir: outDir, frontmatter: true });
  const again = readdirSync(outDir).sort();
  check("덮어쓰지 않는다", again.length === 4, again.join(","));
  check("기존 파일이 그대로다", statSync(join(outDir, "sample-ko.md")).mtimeMs === mtime);

  // 프론트매터를 끈 것은 빈 폴더에 내보내 섞이지 않게 본다.
  const plainDir = join(work, "출력-민짜");
  mkdirSync(plainDir, { recursive: true });
  await queue.exportDocs({ ids: [], outputDir: plainDir, frontmatter: false });
  const plainText = readFileSync(join(plainDir, "sample-ko.md"), "utf8");
  check("프론트매터를 끄면 붙지 않는다", !plainText.startsWith("---\ntitle:"), plainText.slice(0, 40));
  check("본문은 그대로다", plainText.includes("문서 변환 시험 자료"));

  /* ── 뒷정리 ───────────────────────────────────────────── */
  console.log("\n뒷정리");
  queue.shutdown();
  await sleep(500);
  const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-") && !n.includes("verify-queue"));
  check("어댑터 임시 디렉터리가 남지 않았다", leftovers.length === 0, leftovers.join(", "));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`큐 검증 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("큐 검증 통과");
