/**
 * 설정 화면과 그 뒤를 받치는 것들 (docs/design/06-roadmap.md 6b단계).
 *
 * 로드맵이 적어 둔 세 가지를 확인한다.
 *   1. Ollama HTTP 가 응답하지 않아도 CLI 단독으로 동작하고 "잘림을 감지할 수 없음" 경고가 뜬다
 *   2. 진단 리포트를 복사할 수 있다 (내용이 실제로 담겨 있다)
 *   3. 프롬프트 전문이 실제로 쓰이는 것과 같다
 *
 * 가짜 CLI 하니스를 verify-llm.mjs 와 같이 쓴다.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-settings-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });

require.cache[require.resolve("electron")] = {
  exports: { app: { isPackaged: false, getPath: () => userData } },
};

const { settings, updateSettings } = require(join(root, "out/main/settings.js"));
const { parseWithLlm } = require(join(root, "out/main/llm/run.js"));
const { resolveCli, clearCache } = require(join(root, "out/main/llm/resolve.js"));
const { listModels, contextLength, looksTooLong } = require(join(root, "out/main/llm/ollama-http.js"));
const { promptText, buildPrompt, CANNOT_READ } = require(join(root, "out/main/llm/prompt.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

/* ── 가짜 CLI 를 PATH 앞에 ────────────────────────────── */
const bin = join(work, "bin");
mkdirSync(bin, { recursive: true });
for (const name of ["claude", "gemini", "codex", "ollama"]) {
  const target = join(root, "test/fake-cli", `${name}.mjs`);
  const shim = join(bin, name);
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, "utf8");
  chmodSync(shim, 0o755);
}
const realPath = process.env["PATH"] ?? "";

/** 응답하지 않는 포트. 열지 않은 포트로 연결하면 즉시 거절된다. */
const DEAD_URL = "http://127.0.0.1:1";

try {
  /* ── 1. 설정 기본값과 다듬기 ───────────────────────── */
  console.log("\n설정 저장");

  const base = settings();
  check("기본 엔진은 로컬이다", base.defaultEngine === "local", base.defaultEngine);
  check("LLM 기본 제한 시간은 30분", base.llmTimeoutMin === 30, String(base.llmTimeoutMin));
  check("파일 크기 상한 기본 500MB", base.maxFileSizeMb === 500, String(base.maxFileSizeMb));

  // 범위를 벗어난 값은 끌어온다 — 0 분이면 변환이 즉시 실패한다.
  check("동시 실행 수는 1~4 로 제한된다", updateSettings({ concurrency: 99 }).concurrency === 4);
  check("0 이하는 최소값으로", updateSettings({ concurrency: 0 }).concurrency === 1);
  check("제한 시간 0 은 최소 1분으로", updateSettings({ llmTimeoutMin: 0 }).llmTimeoutMin === 1);
  check("모르는 열거값은 기본값으로", updateSettings({ provider: "없는것" }).provider === "claude");
  check("빈 Ollama 주소는 기본값으로", updateSettings({ ollamaUrl: "  " }).ollamaUrl.includes("11434"));
  // build.25 요청. 스캔 문서가 대부분인 곳에서는 문서마다 토글을 켜는 것이 일이다.
  // build.28 실측. 로컬 제한 시간이 10분 고정이라 OCR 스캔 문서가 정상 동작 중에
  // 끊겼다. 기본 30분이고 설정에서 늘릴 수 있다.
  check("로컬 제한 시간 기본은 30분", settings().localTimeoutMin === 30);
  check("늘릴 수 있다", updateSettings({ localTimeoutMin: 90 }).localTimeoutMin === 90);
  check("180분을 넘지 않는다", updateSettings({ localTimeoutMin: 999 }).localTimeoutMin === 180);
  check("0 은 최소 1분으로", updateSettings({ localTimeoutMin: 0 }).localTimeoutMin === 1);
  updateSettings({ localTimeoutMin: 30 });

  check("기본은 꺼짐", settings().ocrByDefault === false);
  check("켜면 저장된다", updateSettings({ ocrByDefault: true }).ocrByDefault === true);
  check("이상한 값은 기본값으로", updateSettings({ ocrByDefault: "네" }).ocrByDefault === false);
  // 이미지 처리 (build.30). 옛 값 external·embedded 는 죽은 파일 참조를 내던
  // 선택지라 없앴다. 저장돼 있던 값이 조용히 남아 화면과 어긋나면 안 된다 —
  // oneOf 가 모르는 값으로 보고 새 기본값 note 로 되돌린다.
  check("기본은 위치만 표시", settings().imageOutput === "note");
  check("제외를 고르면 저장된다", updateSettings({ imageOutput: "off" }).imageOutput === "off");
  check("옛 external 은 note 로", updateSettings({ imageOutput: "external" }).imageOutput === "note");
  updateSettings({ imageOutput: "off" });
  check("옛 embedded 도 note 로", updateSettings({ imageOutput: "embedded" }).imageOutput === "note");
  updateSettings({ imageOutput: "off" });
  check("모르는 값도 note 로", updateSettings({ imageOutput: "무엇" }).imageOutput === "note");

  updateSettings({ concurrency: 1, llmTimeoutMin: 30, provider: "claude", ocrByDefault: false, imageOutput: "note" });

  /* ── 2. 진단 리포트 ────────────────────────────────── */
  console.log("\nCLI 탐지 리포트");

  process.env["PATH"] = `${bin}${delimiter}${realPath}`;
  clearCache();
  const found = await resolveCli("claude");
  check("찾으면 경로를 준다", found.command !== null, found.report.join(" / "));

  process.env["PATH"] = "/nonexistent-for-verify";
  clearCache();
  const missing = await resolveCli("claude");
  check("못 찾으면 null", missing.command === null);
  // 복사 버튼이 옮겨 담을 내용이 실제로 있어야 한다.
  const report = missing.report.join("\n");
  check("리포트에 대상이 담긴다", report.includes("claude"));
  check("리포트에 플랫폼이 담긴다", report.includes(process.platform));
  check("리포트에 확인 항목이 담긴다", report.includes("확인할 것"));
  check("리포트가 한 줄짜리가 아니다", missing.report.length >= 5, String(missing.report.length));

  /* ── 3. 프롬프트 전문이 실제로 쓰이는 것과 같은가 ──── */
  console.log("\n프롬프트 열람");

  for (const mode of ["A", "B"]) {
    for (const language of ["ko", "en", "keep"]) {
      const shown = promptText(mode, language);
      const used = buildPrompt(mode, language, "<문서파일>");
      check(`${mode}·${language}: 보여 주는 것과 쓰는 것이 같다`, shown === used);
    }
  }
  check("모드 A 프롬프트에 표식이 담긴다", promptText("A", "keep").includes(CANNOT_READ));
  check("모드 B 프롬프트에는 표식이 없다", !promptText("B", "keep").includes(CANNOT_READ));
  check("모드가 다르면 내용도 다르다", promptText("A", "ko") !== promptText("B", "ko"));
  check("언어가 다르면 내용도 다르다", promptText("B", "ko") !== promptText("B", "en"));

  /* ── 4. Ollama HTTP 가 없을 때 ─────────────────────── */
  console.log("\nOllama 루프백 조회");

  const dead = await listModels(DEAD_URL);
  check("응답이 없으면 ok=false", dead.ok === false);
  check("사유를 돌려준다", dead.detail !== "", dead.detail);
  check("모델 목록은 빈 배열", Array.isArray(dead.models) && dead.models.length === 0);
  check("컨텍스트 길이는 null", (await contextLength(DEAD_URL, "아무모델")) === null);

  // 살아 있는 경우도 본다 — 가짜 데몬을 띄운다.
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b" }, { name: "llama3:8b" }] }));
    } else if (req.url === "/api/show") {
      res.end(JSON.stringify({ model_info: { "qwen2.arch.context_length": 32768 } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const liveUrl = `http://127.0.0.1:${server.address().port}`;

  const live = await listModels(liveUrl);
  check("살아 있으면 모델 목록을 준다", live.ok && live.models.length === 2, JSON.stringify(live));
  check("컨텍스트 길이를 읽는다", (await contextLength(liveUrl, "qwen2.5:7b")) === 32768);

  // 넘침 판정. 보수적으로 잡아야 한다 — 넘칠 것을 안 넘친다고 하는 쪽이 더 나쁘다.
  check("짧은 입력은 넘치지 않는다", !looksTooLong(1000, 32768));
  check("긴 입력은 넘친다고 본다", looksTooLong(200_000, 32768));

  /* ── 5. HTTP 없이도 변환은 CLI 단독으로 돈다 ───────── */
  console.log("\nHTTP 없이 변환");

  process.env["PATH"] = `${bin}${delimiter}${realPath}`;
  process.env["MARKEXTRACT_FAKE"] = "";
  clearCache();

  const localStage = async () => ({
    ok: true,
    markdown: "# 제목\n\n로컬 파서가 뽑은 본문입니다.\n",
    warnings: [],
    log: [],
    meta: { engine: "로컬 · 시험", elapsedMs: 1 },
  });

  const result = await parseWithLlm(
    {
      filePath: join(root, "test/fixtures/sample-ko.docx"),
      options: { engine: "llm", provider: "ollama", inputMode: "B", model: "시험모델" },
      ollamaUrl: DEAD_URL,
    },
    localStage,
  );

  check("HTTP 가 없어도 변환은 성공한다", result.ok, result.error?.message);
  const warn = result.warnings.find((w) => w.code === "CONTEXT_UNKNOWN");
  check("'잘림을 감지할 수 없음' 경고가 붙는다", warn !== undefined, JSON.stringify(result.warnings));
  check("경고가 이유를 설명한다", (warn?.message ?? "").includes("잘렸을 수 있"), warn?.message);
  check("변환 로그에도 남는다", result.log.some((e) => e.label === "컨텍스트"), JSON.stringify(result.log));

  // 살아 있고 입력이 짧으면 경고가 없어야 한다 — 늘 경고하면 의미가 없다.
  const quiet = await parseWithLlm(
    {
      filePath: join(root, "test/fixtures/sample-ko.docx"),
      options: { engine: "llm", provider: "ollama", inputMode: "B", model: "qwen2.5:7b" },
      ollamaUrl: liveUrl,
    },
    localStage,
  );
  check("컨텍스트를 알고 여유가 있으면 경고가 없다", !quiet.warnings.some((w) => w.code.startsWith("CONTEXT_")), JSON.stringify(quiet.warnings));

  // 길면 넘침 경고.
  const longStage = async () => ({
    ok: true,
    markdown: "가".repeat(120_000),
    warnings: [],
    log: [],
    meta: { engine: "로컬 · 시험", elapsedMs: 1 },
  });
  const overflow = await parseWithLlm(
    {
      filePath: join(root, "test/fixtures/sample-ko.docx"),
      options: { engine: "llm", provider: "ollama", inputMode: "B", model: "qwen2.5:7b" },
      ollamaUrl: liveUrl,
    },
    longStage,
  );
  check("입력이 길면 넘침 경고가 붙는다", overflow.warnings.some((w) => w.code === "CONTEXT_OVERFLOW"), JSON.stringify(overflow.warnings));

  server.close();
} finally {
  process.env["PATH"] = realPath;
  delete process.env["MARKEXTRACT_FAKE"];
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`설정 검증 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("설정 검증 통과");
