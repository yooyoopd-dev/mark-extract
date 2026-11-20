/**
 * OCR · hybrid 서버 연동 검증 (docs/design/06-roadmap.md 7단계).
 *
 * 가짜 서버로 돈다. 진짜 docling 백엔드는 모델을 받아야 하고 이 환경에서는 받을 수
 * 없다 — 검증 대상은 우리 코드다: 연결 판정, 인자 조립, 제한 시간, 토글 자물쇠.
 *
 * 진짜 서버(Docling Fast Server 1.0.0)로 확인한 사실은 02 문서에 적었다.
 * 여기서 흉내 내는 `/health` 응답도 그때 받은 것 그대로다.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-ocr-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });
require.cache[require.resolve("electron")] = {
  exports: { app: { isPackaged: false, getPath: () => userData } },
};

const { testHybrid, isRemote } = require(join(root, "out/main/hybrid-http.js"));
const ocrServer = require(join(root, "out/main/ocr-server.js"));
const { serverArgs, serverCommandLine, serverPort, ensureOcrServer, stopOcrServer, setCommandForVerify, ocrEvents } = ocrServer;
const { buildArgs, failureReason, javaLogForVerify, parsePdf } = require(join(root, "out/main/parsers/pdf-opendataloader.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

/** 인자 배열을 한 줄로. 부분 문자열로 보기 위해 앞뒤에 공백을 둔다. */
const line = (options, hybridUrl = "") =>
  ` ${buildArgs("C:\\docs\\a.pdf", "/out", options, hybridUrl).join(" ")} `;

const DEAD = "http://127.0.0.1:59999";

try {
  /* ── 1. 연결 테스트 ───────────────────────────────── */
  console.log("\nhybrid 연결 테스트");

  const dead = await testHybrid(DEAD);
  check("서버가 없으면 ok=false", dead.ok === false);
  check("사유가 화면에 띄울 만하다", dead.detail.includes(DEAD), dead.detail);
  check("응답 시간은 0", dead.ms === 0);

  const empty = await testHybrid("");
  check("주소가 비면 연결하러 가지 않는다", empty.ok === false && empty.detail.includes("비어"), empty.detail);

  // 진짜 서버가 주는 응답 그대로 흉내 낸다.
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const live = `http://127.0.0.1:${server.address().port}`;

  const up = await testHybrid(live);
  check("서버가 살아 있으면 ok=true", up.ok === true, JSON.stringify(up));
  check("상태 문자열을 돌려준다", up.detail === "ok", up.detail);
  check("응답 시간을 잰다", typeof up.ms === "number" && up.ms >= 0, String(up.ms));

  // /health 가 없는 서버. 200 이 아니면 연결로 치지 않는다.
  const bare = createServer((_req, res) => {
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  const bareUrl = `http://127.0.0.1:${bare.address().port}`;
  const notServer = await testHybrid(bareUrl);
  check("/health 가 404 면 연결 실패로 본다", notServer.ok === false, JSON.stringify(notServer));

  // server 는 4절(실제 실행)에서 한 번 더 쓴다 — /health 에만 답하는 서버다.
  bare.close();

  /* ── 2. 원격 주소 판정 ────────────────────────────── */
  console.log("\n원격 주소");
  //
  // OCR 을 켜면 PDF 원본이 그 서버로 나간다. 루프백이 아니면 화면이 알려야 한다.
  check("127.0.0.1 은 원격이 아니다", isRemote("http://127.0.0.1:5002") === false);
  check("localhost 도 원격이 아니다", isRemote("http://localhost:5002") === false);
  check("사내 호스트는 원격이다", isRemote("http://ocr.corp.local:5002") === true);
  check("공인 주소도 원격이다", isRemote("https://ocr.example.com") === true);

  /* ── 3. 인자 조립 ─────────────────────────────────── */
  console.log("\nCLI 인자");

  check("OCR 을 끄면 --hybrid 가 없다", !line({}).includes(" --hybrid "), line({}));
  check(
    "서버 주소가 없으면 OCR 을 켜도 붙지 않는다",
    !line({ ocr: true }, "").includes(" --hybrid "),
    line({ ocr: true }, ""),
  );

  const on = line({ ocr: true }, live);
  check("OCR 을 켜면 docling-fast 로 붙는다", on.includes(" --hybrid docling-fast "), on);
  check("서버 주소가 넘어간다", on.includes(` --hybrid-url ${live} `), on);
  check("기본은 --hybrid-mode 를 넘기지 않는다 (CLI 기본 auto)", !on.includes("--hybrid-mode"), on);

  const full = line({ ocr: true, hybridFullPages: true }, live);
  check("모든 페이지 보내기는 --hybrid-mode full", full.includes(" --hybrid-mode full "), full);

  // 결정 6 — 서버 오류를 조용히 Java 경로로 되돌리지 않는다. 되돌리면 사용자는
  // OCR 이 안 걸린 결과를 OCR 결과로 믿는다.
  for (const [label, options] of [
    ["기본", {}],
    ["OCR 켬", { ocr: true }],
    ["전 페이지", { ocr: true, hybridFullPages: true }],
    ["구조 트리와 함께", { ocr: true, useStructTree: true }],
  ]) {
    check(`--hybrid-fallback 은 붙지 않는다 (${label})`, !line(options, live).includes("--hybrid-fallback"));
  }

  const st = line({ useStructTree: true }, live);
  check("구조 트리는 --use-struct-tree", st.includes(" --use-struct-tree "), st);
  check("구조 트리만 켜면 --hybrid 는 없다", !st.includes(" --hybrid "), st);

  // 둘 다 켠 경우. 인자는 둘 다 나가고, 태그드 PDF 에서 어느 쪽이 이기는지는 CLI 가
  // 정한다(실측: 구조 트리가 이기고 서버를 부르지 않는다). 우리는 화면에 알린다.
  const both = line({ ocr: true, useStructTree: true }, live);
  check("둘 다 켜면 인자도 둘 다 나간다", both.includes("--use-struct-tree") && both.includes("--hybrid "), both);

  // --quiet 는 로그를 통째로 꺼 버려 실패 사유도 경고도 사라진다 (실측).
  check("--quiet 를 쓰지 않는다", !line({}).includes("--quiet"), line({}));

  // 그림 처리 (build.30). 위치를 말하려면 엔진이 쪽 경계와 그림 자리를 찍어 줘야
  // 한다 — 이 두 인자가 빠지면 image-notes.ts 는 아무것도 할 수 없다.
  check("쪽 구분자를 늘 넘긴다", line({}).includes("--markdown-page-separator"), line({}));
  check("기본은 --image-output external", line({}).includes(" --image-output external "), line({}));
  check(
    "제외를 고르면 엔진도 그림을 뽑지 않는다",
    line({ imageOutput: "off" }).includes(" --image-output off "),
    line({ imageOutput: "off" }),
  );

  /* ── 4. 실제 실행 — 서버가 꺼졌을 때 ──────────────── */
  //
  // 동봉 JRE 로 진짜 CLI 를 돌린다.
  //
  // build.37 에서 또 뜻이 바뀌었다. build.34 는 "서버가 없으면 OCR 없이 변환" 했는데,
  // 그것은 OCR 이 설정 기본값으로 심기던 시절의 보호막이었다. 이제 OCR 은 사용자가
  // **직접** 켤 때만 붙고, 그때 서버가 없으면 앱이 띄운다. 띄울 수 없으면 조용히 OCR
  // 을 빼지 않고 사유와 함께 실패한다. 여기서는 실행 파일이 없는 경우로 고정한다 —
  // 검증 PC 에 진짜 서버가 깔려 있으면 진짜로 떠 버리기 때문이다.
  console.log("\n서버 미구동 (실제 실행)");

  const fixture = join(root, "test/fixtures/sample-ko.pdf");
  setCommandForVerify(join(work, "없는-실행파일"));
  const down = await parsePdf({ filePath: fixture, options: { ocr: true }, hybridUrl: DEAD });

  check("띄울 수 없으면 실패한다", down.ok === false, JSON.stringify(down.error?.code));
  check("사유를 OCR 서버로 특정한다", down.error?.code === "OCR_SERVER_UNAVAILABLE", down.error?.code);
  check("설치가 안 됐다고 말한다", String(down.error?.message).includes("설치"), down.error?.message);
  check("OCR 설정으로 가는 버튼을 준다", down.error?.actions.includes("open-ocr-settings"), JSON.stringify(down.error?.actions));
  check("Java 는 띄우지 않았다", !down.log.some((e) => e.label === "인자"), JSON.stringify(down.log.map((e) => e.label)));
  stopOcrServer();

  /* ── 4-b. /health 는 답하는데 변환은 못 하는 서버 ───── */
  //
  // 시작 전 확인을 지나면 --hybrid 를 붙인다. 그 뒤의 실패는 지금처럼 실패다 — 변환
  // 도중 조용히 Java 경로로 되돌리지 않는다 (결정 6).
  console.log("\n/health 만 답하는 서버 (실제 실행)");
  // 떠 있는 서버를 찾아 쓴다 — 앱이 띄우지 않는다.

  const half = await parsePdf({ filePath: fixture, options: { ocr: true }, hybridUrl: live });
  const halfArgs = half.log.find((e) => e.label === "인자")?.value ?? "";
  check("살아 있으면 --hybrid 를 붙인다", halfArgs.includes(`--hybrid-url ${live}`), halfArgs);
  check("서버가 변환을 못 하면 실패한다", half.ok === false, JSON.stringify(half.error?.code));
  check(
    "엔진이 낸 사유를 그대로 보여 준다",
    String(half.error?.message).includes("Backend processing failed"),
    String(half.error?.message).slice(0, 200),
  );
  check(
    "제한 시간이 30분으로 올라간 사실이 로그에 남는다",
    half.log.some((e) => e.label === "OCR" && e.value.includes("30분")),
    JSON.stringify(half.log.map((e) => e.label)),
  );
  // build.28 실측. OCR 을 켠 스캔 문서가 10분에 끊겼는데, 로그에 "30분" 이 문구로
  // 박혀 있어 실제로 몇 분을 쓴 것인지 로그만 보고는 알 수 없었다.
  check(
    "실제로 쓴 제한 시간이 로그에 따로 남는다",
    half.log.some((e) => e.label === "제한 시간" && e.value === "30분"),
    JSON.stringify(half.log.filter((e) => e.label === "제한 시간")),
  );
  // 설정에서 더 늘리면 그 값을 쓴다.
  const long = await parsePdf({ filePath: fixture, options: { ocr: true, timeoutMs: 90 * 60_000 }, hybridUrl: live });
  check(
    "설정이 30분보다 크면 그 값을 쓴다",
    long.log.some((e) => e.label === "제한 시간" && e.value === "90분"),
    JSON.stringify(long.log.filter((e) => e.label === "제한 시간")),
  );
  // 반대로 작게 잡아도 OCR 은 30분을 보장한다 — 스캔 문서를 짧은 값으로 끊으면
  // 정상 동작이 실패가 된다.
  const short = await parsePdf({ filePath: fixture, options: { ocr: true, timeoutMs: 5 * 60_000 }, hybridUrl: live });
  check(
    "OCR 은 설정이 작아도 30분은 기다린다",
    short.log.some((e) => e.label === "제한 시간" && e.value === "30분"),
    JSON.stringify(short.log.filter((e) => e.label === "제한 시간")),
  );
  // OCR 이 아닌 경로는 설정값을 그대로 쓴다.
  const localShort = await parsePdf({ filePath: fixture, options: { timeoutMs: 5 * 60_000 } });
  check(
    "OCR 이 아니면 설정값을 그대로 쓴다",
    localShort.log.some((e) => e.label === "제한 시간" && e.value === "5분"),
    JSON.stringify(localShort.log.filter((e) => e.label === "제한 시간")),
  );
  check("그대로 재시도를 제안한다", half.error?.actions.includes("retry-plain"), JSON.stringify(half.error?.actions));
  server.close();

  stopOcrServer();
  const plain = await parsePdf({ filePath: fixture, options: {}, hybridUrl: DEAD });
  check("OCR 을 끄면 그대로 변환된다", plain.ok === true, JSON.stringify(plain.error));
  check("OCR 을 끄면 서버를 띄우지 않는다", ocrServer.ocrStatus().phase === "off", ocrServer.ocrStatus().phase);

  /* ── 5. stderr 레벨 가르기 ────────────────────────── */
  //
  // 처음에는 "sample-ko.pdf 를 변환하면 경고가 하나 나온다"로 단언했는데, 그건 우리
  // 코드가 아니라 **엔진이 그 파일에 무엇을 내느냐**에 대한 단언이었다. 리눅스에서는
  // Detected background 가 나오고 Windows 에서는 나오지 않아 CI 가 잡았다.
  // 검증할 것은 javaLog() 가 레벨을 가르는 일이다. 실측한 stderr 를 그대로 먹인다.
  console.log("\nstderr 레벨 가르기");

  const REAL = [
    "Sep 17, 2026 2:25:00 PM org.opendataloader.pdf.processors.DocumentProcessor preprocessing",
    "INFO: File name: /tmp/a.pdf",
    "Sep 17, 2026 2:25:00 PM org.opendataloader.pdf.processors.DocumentProcessor calculateDocumentInfo",
    "INFO: Number of pages: 1",
    "Sep 17, 2026 2:25:00 PM org.opendataloader.pdf.processors.HybridDocumentProcessor processBackendPath",
    "WARNING: Detected background on page 1",
    "Sep 17, 2026 2:25:00 PM org.opendataloader.pdf.cli.CLIMain processFile",
    "SEVERE: Exception during processing file /tmp/a.pdf: Hybrid server is not available at http://127.0.0.1:59999",
    "To start the local hybrid server:",
    '  1. Install: pip install "opendataloader-pdf[hybrid]"',
    "  2. Start:   opendataloader-pdf-hybrid --port 5002",
    "Or run without --hybrid flag for Java-only processing.",
  ].join("\n");

  const parsed = javaLogForVerify(REAL);
  check("WARNING 이 사용자 경고가 된다", parsed.warnings.length === 1, JSON.stringify(parsed.warnings));
  check(
    "경고 본문이 그대로 실린다",
    parsed.warnings[0]?.message === "Detected background on page 1",
    JSON.stringify(parsed.warnings[0]),
  );
  check("경고 코드는 ENGINE_WARNING", parsed.warnings[0]?.code === "ENGINE_WARNING");
  check("SEVERE 는 실패 사유로 간다", parsed.severe.length === 1, JSON.stringify(parsed.severe));
  check(
    "여러 줄짜리 SEVERE 가 끝까지 모인다",
    parsed.severe[0]?.includes("pip install") && parsed.severe[0]?.includes("Java-only processing"),
    JSON.stringify(parsed.severe[0]),
  );
  check(
    "INFO 는 버린다",
    !JSON.stringify(parsed).includes("Number of pages"),
    JSON.stringify(parsed).slice(0, 120),
  );

  // INFO 분기가 실제로 하는 일. 머리글 줄 없이 INFO 가 바로 붙는 경우, 그것을
  // 끊어 주지 않으면 앞 기록의 본문에 빨려 들어간다. 지금 포매터는 늘 머리글을
  // 내지만, 그 사실에 기대는 코드를 시험 없이 두지 않는다.
  const glued = javaLogForVerify(
    ["SEVERE: 무언가 실패했습니다", "  이어지는 줄", "INFO: 페이지 수 3", "INFO: 제목 없음"].join("\n"),
  );
  check("머리글 없이 붙은 INFO 가 앞 기록에 섞이지 않는다", glued.severe.length === 1, JSON.stringify(glued));
  check(
    "그 INFO 본문도 버려진다",
    !glued.severe[0]?.includes("페이지 수"),
    JSON.stringify(glued.severe[0]),
  );
  const blank = javaLogForVerify("");
  check("빈 stderr 는 아무것도 만들지 않는다", blank.warnings.length === 0 && blank.severe.length === 0);

  /* ── 6. 실패 사유 — SEVERE 가 없을 때 ────────────── */
  //
  // build.30 보고가 "변환 엔진이 1 로 끝났습니다" 한 줄이었다. 그 문구는 severe 가
  // 비었을 때만 나온다 — javaLog 가 java.util.logging 모양만 모으므로 JVM 초기화
  // 실패처럼 그 앞에서 끝난 실패는 원본까지 통째로 버려졌다.
  console.log("\n실패 사유");
  check(
    "SEVERE 가 있으면 그것을 쓴다",
    failureReason(["서버가 없습니다"], "Error occurred during initialization of VM", "", 1) === "서버가 없습니다",
  );
  const raw = failureReason([], "Error occurred during initialization of VM\nCould not reserve enough space", "", 1);
  check("SEVERE 가 없으면 stderr 원본이 들어 있다", raw.includes("Could not reserve enough space"), raw);
  check("어디서 온 것인지 적는다", raw.includes("--- stderr ---"), raw);
  check("종료 코드도 남는다", raw.includes("1 로 끝났습니다"), raw);
  const onlyOut = failureReason([], "   ", "Unable to access jarfile", 2);
  check("stderr 가 비면 stdout 을 쓴다", onlyOut.includes("Unable to access jarfile"), onlyOut);
  check("그때는 stdout 이라고 적는다", onlyOut.includes("--- stdout ---"), onlyOut);
  const bothEmpty = failureReason([], "", "", 3);
  check("둘 다 비면 그 사실을 적는다", bothEmpty.includes("모두 비어 있습니다") && bothEmpty.includes("3"), bothEmpty);
  // 큰 문서의 INFO 는 수천 줄이다. 실패는 끝에 적히므로 꼬리를 남긴다.
  const longReason = failureReason([], `${"INFO: 페이지\n".repeat(2000)}마지막 줄이 사유다`, "", 1);
  check("긴 stderr 는 잘린다", longReason.length < 4400, String(longReason.length));
  check("잘려도 끝부분이 남는다", longReason.includes("마지막 줄이 사유다"), longReason.slice(-60));
  check("자른 것을 알린다", longReason.includes("앞부분 생략"), longReason.slice(0, 80));

  /* ── 7. OCR 서버를 앱이 띄운다 (build.37) ─────────── */
  //
  // 가짜 서버로 상태 기계를 본다. 가짜는 진짜가 사내 PC 에서 찍은 첫 줄
  // ("ERROR - Preset … already registered")을 그대로 찍는다 — 그 줄이 실패로 읽혔다.
  // 판정은 /health 하나여야 한다.
  console.log("\nOCR 서버 관리");

  const args = serverArgs("http://127.0.0.1:7000").join(" ");
  check("주소의 포트를 따른다", args.includes("--port 7000"), args);
  // 이것이 빠지면 서버가 0.0.0.0 에 열려 사내망의 다른 PC 가 PDF 를 보낼 수 있다 (사내 PC 실측).
  check("이 PC 에만 연다 (--host 127.0.0.1)", args.includes("--host 127.0.0.1"), args);
  for (const [name, url] of [["빈 주소", ""], ["포트 없는 주소", "http://ocr.example"], ["형식이 아닌 값", "그냥글자"]]) {
    check(`${name} 이면 5002 로 떨어진다`, serverPort(url) === "5002", serverPort(url));
  }
  check("--force-ocr · --ocr-lang ko,en", args.includes("--force-ocr") && args.includes("--ocr-lang ko,en"), args);
  check("복사용 줄은 ko,en 을 감싼다", serverCommandLine("").includes('--ocr-lang "ko,en"'), serverCommandLine(""));
  check("복사용 줄에도 --host 가 있다", serverCommandLine("").includes("--host 127.0.0.1"), serverCommandLine(""));

  const fake = join(work, "fake-hybrid.cjs");
  const seen = join(work, "fake-seen.txt");
  writeFileSync(
    fake,
    `const http = require("node:http");
const fs = require("node:fs");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, utf8: process.env.PYTHONUTF8 }) + "\\n");
console.error("2026-11-20 10:46:33,739 - ERROR - Preset 'granite_vision_v4' already registered");
const mode = process.env.FAKE_MODE || "ok";
if (mode === "exit") { console.error("ModuleNotFoundError: No module named 'docling'"); process.exit(3); }
console.log("INFO - Loading plugin 'docling_defaults'");
if (mode === "never") setInterval(() => {}, 1000);
else setTimeout(() => {
  http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end('{"status":"ok"}'); })
    .listen(port, "127.0.0.1", () => console.log("INFO: Uvicorn running on http://127.0.0.1:" + port));
}, Number(process.env.FAKE_DELAY || 800));
`,
  );
  const freePort = () =>
    new Promise((resolve) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
  const seenLines = () => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").filter(Boolean) : []);

  setCommandForVerify(process.execPath, [fake], 8000);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const phases = [];
  const lastLines = [];
  const onChange = (st) => {
    phases.push(st.phase);
    if (st.lastLine) lastLines.push(st.lastLine);
  };
  ocrEvents.on("changed", onChange);

  // 두 문서가 동시에 OCR 을 요청한다. 서버는 하나만 떠야 한다.
  const [first, second] = await Promise.all([ensureOcrServer(url), ensureOcrServer(url)]);
  check("준비되면 켜짐", first.phase === "on" && second.phase === "on", `${first.phase}/${second.phase}: ${first.detail}`);
  check("ERROR 로그가 있어도 켜짐으로 본다", lastLines.length > 0 && first.phase === "on", JSON.stringify(lastLines.slice(0, 2)));
  check("켜는 중 → 켜짐 순서로 방송한다", phases.indexOf("starting") >= 0 && phases.indexOf("starting") < phases.indexOf("on"), JSON.stringify(phases));
  check("앱이 띄운 서버로 적는다", first.managed === true, JSON.stringify(first));
  check("동시 요청에도 서버는 하나", seenLines().length === 1, String(seenLines().length));
  const launched = JSON.parse(seenLines()[0] ?? "{}");
  check("실제 인자에 --host 127.0.0.1", (launched.argv ?? []).join(" ").includes("--host 127.0.0.1"), JSON.stringify(launched.argv));
  check("UTF-8 모드로 띄운다 (PYTHONUTF8=1)", launched.utf8 === "1", String(launched.utf8));
  check("이미 켜져 있으면 다시 띄우지 않는다", (await ensureOcrServer(url)).phase === "on" && seenLines().length === 1, String(seenLines().length));

  stopOcrServer();
  await new Promise((r) => setTimeout(r, 400));
  check("끄면 꺼짐", ocrServer.ocrStatus().phase === "off", ocrServer.ocrStatus().phase);
  check("끄면 프로세스도 끝난다", (await testHybrid(url)).ok === false, "");

  // 준비 전에 끝나는 서버 — 의존성이 빠진 설치 같은 경우. 로그 꼬리를 보여 줘야 한다.
  process.env.FAKE_MODE = "exit";
  const crashed = await ensureOcrServer(`http://127.0.0.1:${await freePort()}`);
  check("준비 전에 끝나면 실패", crashed.phase === "failed", crashed.detail);
  check("사유가 '준비되기 전에 끝났습니다'", crashed.detail.includes("준비되기 전에 끝났습니다"), crashed.detail);
  check("로그 꼬리를 남긴다", String(crashed.tail).includes("No module named"), String(crashed.tail));

  // 끝나지도 준비되지도 않는 서버 — 제한 시간에 끊는다.
  process.env.FAKE_MODE = "never";
  setCommandForVerify(process.execPath, [fake], 1500);
  const hung = await ensureOcrServer(`http://127.0.0.1:${await freePort()}`);
  check("제한 시간 안에 준비되지 않으면 실패", hung.phase === "failed" && hung.detail.includes("준비되지 않았습니다"), hung.detail);
  delete process.env.FAKE_MODE;

  // 실행 파일이 없다 — 설치 안내로.
  setCommandForVerify(join(work, "없는-실행파일"));
  const missing = await ensureOcrServer(`http://127.0.0.1:${await freePort()}`);
  check("설치되어 있지 않으면 missing", missing.phase === "failed" && missing.missing === true, JSON.stringify(missing));

  // 앱 밖에서 이미 떠 있는 서버는 그대로 쓰고, 끄지 않는다.
  const outside = createServer((_req, res) => res.end('{"status":"ok"}'));
  await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
  const outsideUrl = `http://127.0.0.1:${outside.address().port}`;
  const external = await ensureOcrServer(outsideUrl);
  check("떠 있는 서버를 찾아 쓴다", external.phase === "on" && external.managed === false, JSON.stringify(external));
  stopOcrServer();
  check("앱 밖의 서버는 끄지 않는다", (await testHybrid(outsideUrl)).ok === true, "");
  outside.close();

  // 원격 주소는 띄우지 않는다.
  setCommandForVerify(process.execPath, [fake], 8000);
  const before = seenLines().length;
  const remote = await ensureOcrServer("http://ocr.invalid:5002");
  check("원격 주소면 띄우지 않고 실패", remote.phase === "failed" && seenLines().length === before, remote.detail);
  ocrEvents.off("changed", onChange);

  // OCR 을 켠 PDF: 서버가 꺼져 있으면 앱이 띄운 뒤 --hybrid 로 변환한다.
  stopOcrServer();
  const autoUrl = `http://127.0.0.1:${await freePort()}`;
  const auto = await parsePdf({ filePath: fixture, options: { ocr: true }, hybridUrl: autoUrl });
  const autoArgs = auto.log.find((e) => e.label === "인자")?.value ?? "";
  check("OCR 을 켜면 서버를 띄운다", ocrServer.ocrStatus().phase === "on" && ocrServer.ocrStatus().managed, JSON.stringify(ocrServer.ocrStatus()));
  check("띄운 뒤 그 서버로 변환한다", autoArgs.includes(`--hybrid-url ${autoUrl}`), autoArgs);
  stopOcrServer();

  /* ── 8. 기존 인자가 그대로인지 ────────────────────── */
  console.log("\n회귀");
  const base = line({});
  for (const flag of ["--format markdown", "--keep-line-breaks", "--markdown-with-html", "--output-dir"]) {
    check(`${flag} 는 그대로다`, base.includes(flag), base);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.log(`OCR 검증 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("OCR 검증 통과");
