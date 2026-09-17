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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const { buildArgsForVerify, javaLogForVerify, parsePdf } = require(join(root, "out/main/parsers/pdf-opendataloader.js"));

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
  ` ${buildArgsForVerify("C:\\docs\\a.pdf", "/out", options, hybridUrl).join(" ")} `;

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

  /* ── 6. 기존 인자가 그대로인지 ────────────────────── */
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
