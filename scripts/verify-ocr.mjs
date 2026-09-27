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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-ocr-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });
require.cache[require.resolve("electron")] = {
  // getAppPath 는 diagnose-bat.ts 가 동봉 시험 자료를 찾는 데 쓴다 (self-test.fixturesDir).
  exports: { app: { isPackaged: false, getPath: () => userData, getAppPath: () => root } },
};

const { testHybrid, isRemote } = require(join(root, "out/main/hybrid-http.js"));
const { buildBatch, writeBatch } = require(join(root, "out/main/diagnose-bat.js"));
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

  server.close();
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
  // 동봉 JRE 로 진짜 CLI 를 돌린다. 연결 거부는 즉시 나므로 빠르다.
  console.log("\n서버 미구동 (실제 실행)");

  const fixture = join(root, "test/fixtures/sample-ko.pdf");
  const down = await parsePdf({ filePath: fixture, options: { ocr: true }, hybridUrl: DEAD });

  check("서버가 없으면 변환이 실패한다", down.ok === false, JSON.stringify(down.error?.code));
  check(
    "사유를 hybrid 로 특정한다",
    down.error?.code === "HYBRID_UNAVAILABLE",
    `${down.error?.code}: ${String(down.error?.message).slice(0, 120)}`,
  );
  // --quiet 를 쓰던 때에는 stderr 가 통째로 비어 "엔진이 1 로 끝났습니다"만 남았다.
  check(
    "CLI 가 내주는 설치·구동 안내가 살아 있다",
    String(down.error?.message).includes("pip install") && String(down.error?.message).includes("opendataloader-pdf-hybrid"),
    String(down.error?.message).slice(0, 200),
  );
  check(
    "여러 줄짜리 안내가 잘리지 않는다",
    String(down.error?.message).split("\n").length >= 4,
    JSON.stringify(String(down.error?.message).slice(0, 160)),
  );
  check(
    "제한 시간이 30분으로 올라간 사실이 로그에 남는다",
    down.log.some((e) => e.label === "OCR" && e.value.includes("30분")),
    JSON.stringify(down.log.map((e) => e.label)),
  );
  // build.28 실측. OCR 을 켠 스캔 문서가 10분에 끊겼는데, 로그에 "30분" 이 문구로
  // 박혀 있어 실제로 몇 분을 쓴 것인지 로그만 보고는 알 수 없었다.
  check(
    "실제로 쓴 제한 시간이 로그에 따로 남는다",
    down.log.some((e) => e.label === "제한 시간" && e.value === "30분"),
    JSON.stringify(down.log.filter((e) => e.label === "제한 시간")),
  );
  // 설정에서 더 늘리면 그 값을 쓴다.
  const long = await parsePdf({ filePath: fixture, options: { ocr: true, timeoutMs: 90 * 60_000 }, hybridUrl: DEAD });
  check(
    "설정이 30분보다 크면 그 값을 쓴다",
    long.log.some((e) => e.label === "제한 시간" && e.value === "90분"),
    JSON.stringify(long.log.filter((e) => e.label === "제한 시간")),
  );
  // 반대로 작게 잡아도 OCR 은 30분을 보장한다 — 스캔 문서를 짧은 값으로 끊으면
  // 정상 동작이 실패가 된다.
  const short = await parsePdf({ filePath: fixture, options: { ocr: true, timeoutMs: 5 * 60_000 }, hybridUrl: DEAD });
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
  check("그대로 재시도를 제안한다", down.error?.actions.includes("retry-plain"), JSON.stringify(down.error?.actions));

  const plain = await parsePdf({ filePath: fixture, options: {}, hybridUrl: DEAD });
  check("OCR 을 끄면 그대로 변환된다", plain.ok === true, JSON.stringify(plain.error));

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

  /* ── 7. 진단 배치 ──────────────────────────────────── */
  //
  // 터미널 실행이 앱 실행과 **같은 명령**이어야 진단이 된다. 인자가 갈라지면
  // 터미널에서 되는데 앱에서 안 되는 이유를 여기서 만들어 내는 셈이다.
  console.log("\n진단 배치");
  const URL = "http://127.0.0.1:5002";
  const bat = buildBatch({
    java: "C:\\Program Files\\Mark Extract\\resources\\jre\\bin\\java.exe",
    jar: "C:\\Program Files\\Mark Extract\\resources\\lib\\opendataloader-pdf-cli.jar",
    hybridUrl: URL,
    sample: "C:\\Program Files\\Mark Extract\\resources\\fixtures\\sample-ko.pdf",
    ocrArgs: buildArgs("%TARGET%", "%OUTROOT%", { ocr: true }, URL),
    localArgs: buildArgs("%TARGET%", "%OUTROOT%", {}, ""),
  });

  check("코드페이지를 UTF-8 로 바꾼다", bat.includes("chcp 65001"), "");
  check("창이 닫히지 않는다", /\r\npause\r\n/.test(bat), "");
  check("CRLF 로 쓴다", bat.includes("\r\n") && !/[^\r]\n/.test(bat), "");
  check("java 경로가 따옴표 안에 있다", bat.includes('set "JAVA=C:\\Program Files'), "");
  check("JAR 경로가 따옴표 안에 있다", bat.includes('set "JAR=C:\\Program Files'), "");
  check("curl 로 /health 를 두드린다", bat.includes('curl.exe -sS -i --max-time 10 "%URL%/health"'), "");
  check("PowerShell 로 한 번 더 두드린다", bat.includes("Invoke-WebRequest"), "");
  check("OCR 절이 --hybrid-url 을 쓴다", bat.includes(`"--hybrid-url" "${URL}"`), "");
  check("OCR 절과 로컬 절의 출력 폴더가 다르다", bat.includes("markextract-diag") && bat.includes('"%OUTROOT%\\hybrid"') && bat.includes('"%OUTROOT%\\local"'), "");
  check("로컬 절에는 --hybrid 가 없다", bat.split("4) 로컬 변환")[1]?.includes("--hybrid") === false, "");
  check("끌어다 놓은 파일을 쓴다", bat.includes('set "TARGET=%~1"') && bat.includes('"%TARGET%"'), "");
  check("인자가 없으면 동봉 자료로 떨어진다", bat.includes('if "%TARGET%"=="" set "TARGET=C:\\Program Files'), "");
  // 페이지 구분자에 %page-number% 가 들어 있다. 늘리지 않으면 cmd 가 먹어 버린다.
  check("% 를 %% 로 늘린다", bat.includes("%%page-number%%"), "");
  check("늘리지 않은 %page-number% 는 없다", !/[^%]%page-number%[^%]/.test(bat), "");
  // 페이지 구분자·표 인자가 앱과 같아야 한다.
  for (const flag of ['"--markdown-with-html"', '"--keep-line-breaks"', '"--image-output" "external"']) {
    check(`${flag} 가 앱과 같다`, bat.includes(flag), "");
  }

  const noUrl = buildBatch({
    java: "j.exe",
    jar: "a.jar",
    hybridUrl: "",
    sample: "s.pdf",
    ocrArgs: buildArgs("%TARGET%", "%OUTROOT%", { ocr: true }, ""),
    localArgs: buildArgs("%TARGET%", "%OUTROOT%", {}, ""),
  });
  check("주소가 없으면 health·OCR 절이 빠진다", !noUrl.includes("curl.exe") && !noUrl.includes("3) OCR 변환"), "");
  check("그래도 로컬 절은 남는다", noUrl.includes("4) 로컬 변환"), "");

  const written = await writeBatch();
  check("설정 폴더에 남는다", written.endsWith("diagnose-ocr.bat") && existsSync(written), written);
  check("파일 내용이 배치다", readFileSync(written, "utf8").startsWith("@echo off"), "");

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
