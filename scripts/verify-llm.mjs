/**
 * LLM CLI 계층 검증 (docs/design/06-roadmap.md 6a단계).
 *
 * 가짜 CLI(test/fake-cli/)로 돈다. 모델을 부르지 않으므로 결정적이고 오프라인에서
 * 돈다. 검증 대상은 우리 코드다 — 인자 조합, 줄 파싱, 중복 제거, 모드 A 격리,
 * 오류 진단.
 *
 * 진짜 CLI 가 이 형식대로 말하는지는 이것으로 알 수 없다. claude 는 따로 실제로
 * 돌려 확인했다 (scripts/probe-claude.mjs).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-llm-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });

require.cache[require.resolve("electron")] = {
  exports: { app: { isPackaged: false, getPath: () => userData } },
};

const { parseWithLlm, stripOuterFence } = require(join(root, "out/main/llm/run.js"));
const { resolveCli, clearCache } = require(join(root, "out/main/llm/resolve.js"));
const { diagnose, looksUnauthenticated, tailJoin } = require(join(root, "out/main/llm/diagnose.js"));
const { providerOf } = require(join(root, "out/main/llm/providers/index.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = (name) => join(root, "test/fixtures", name);

/* ── 가짜 CLI 를 PATH 앞에 둔다 ──────────────────────── */

const bin = join(work, "bin");
mkdirSync(bin, { recursive: true });
for (const name of ["claude", "gemini", "codex", "ollama"]) {
  const target = join(root, "test/fake-cli", `${name}.mjs`);
  const shim = join(bin, name);
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, "utf8");
  chmodSync(shim, 0o755);
}
const realPath = process.env["PATH"] ?? "";
const withFakes = `${bin}${delimiter}${realPath}`;

/** 가짜 CLI 의 동작을 고르고 파서를 돌린다. */
async function run(provider, { fake = "", mode = "B", model, signal, localStage } = {}) {
  process.env["PATH"] = withFakes;
  process.env["MARKEXTRACT_FAKE"] = fake;
  clearCache();

  const stage =
    localStage ??
    (async () => ({
      ok: true,
      markdown: "# 로컬 단계 결과\n\n로컬 파서가 뽑은 본문입니다.\n",
      warnings: [],
      log: [],
      meta: { engine: "로컬 · 시험", elapsedMs: 1 },
    }));

  const options = { engine: "llm", provider, inputMode: mode };
  if (model !== undefined) options.model = model;

  const request = { filePath: fixture("sample-ko.docx"), options };
  if (signal) request.signal = signal;
  return parseWithLlm(request, stage);
}

/** 돌고 있는 가짜 CLI 프로세스 수. 실행 파일이 node 인 것만 센다. */
function fakeProcesses() {
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-eo", "comm=,args="], { encoding: "utf8" });
    return out.split("\n").filter((l) => /^node\b/.test(l.trim()) && l.includes("test/fake-cli/")).length;
  } catch {
    return null;
  }
}

try {
  /* ── 1. CLI 탐색 ──────────────────────────────────── */
  console.log("\nCLI 탐색");

  process.env["PATH"] = withFakes;
  clearCache();
  for (const name of ["claude", "gemini", "codex", "ollama"]) {
    const found = await resolveCli(name);
    check(`${name} 를 찾는다`, found.command !== null, found.report.join(" / "));
  }

  process.env["PATH"] = "/nonexistent-dir-for-verify";
  clearCache();
  const missing = await resolveCli("claude");
  check("없으면 command 가 null 이다", missing.command === null);
  check(
    "없을 때 진단 리포트가 나온다",
    missing.report.length >= 5 && missing.report.some((l) => l.includes("확인할 것")),
    missing.report.join(" / "),
  );
  check("리포트에 플랫폼이 담긴다", missing.report.some((l) => l.includes(process.platform)));

  /* ── 2. claude 스트림 중복 제거 ──────────────────── */
  console.log("\nclaude 스트림 파싱");

  /**
   * 가짜 CLI 가 내놓기로 한 본문. 전체를 통째로 대조한다.
   *
   * 처음에는 "한글 본문입니다." 가 몇 번 나오는지 셌는데, 그 문구가 본문 끝에 있어
   * 누적 복사본이 여러 개 이어져도 완전한 형태로는 한 번만 나왔다. 중복을 그대로
   * 통과시켰다. 부분 문자열을 세지 말고 전체를 비교한다.
   */
  const EXPECT = "# 제목\n\n한글 본문입니다.";
  const body = (result) => (result.markdown ?? "").trim();

  const mixed = await run("claude", { fake: "mixed" });
  check("증분 + 전체가 섞여도 변환에 성공한다", mixed.ok, mixed.error?.message);
  check("본문이 정확히 한 벌이다", body(mixed) === EXPECT, JSON.stringify(mixed.markdown));

  const deltaOnly = await run("claude", { fake: "delta-only" });
  check("증분만 오는 경우", deltaOnly.ok && body(deltaOnly) === EXPECT, JSON.stringify(deltaOnly.markdown));

  const wholeOnly = await run("claude", { fake: "whole-only" });
  check(
    "증분 없이 전체만 오는 버전도 중복이 없다",
    wholeOnly.ok && body(wholeOnly) === EXPECT,
    JSON.stringify(wholeOnly.markdown),
  );

  // assistant 가 증분보다 뒤처져 오는 경우. 접두사 비교만으로는 어긋났다고 보고
  // 통째로 다시 내보내게 된다 — sawDelta 가 막는 자리다.
  const lagging = await run("claude", { fake: "lagging" });
  check("assistant 가 뒤처져 와도 중복이 없다", lagging.ok && body(lagging) === EXPECT, JSON.stringify(lagging.markdown));

  const noisy = await run("claude", { fake: "noisy" });
  check("훅 이벤트가 본문에 섞이지 않는다", noisy.ok && body(noisy) === EXPECT, JSON.stringify(noisy.markdown).slice(0, 120));

  /* ── 3. 다른 프로바이더 ───────────────────────────── */
  console.log("\ngemini · codex · ollama");

  const gem = await run("gemini");
  check("gemini 변환 성공", gem.ok && body(gem) === EXPECT, JSON.stringify(gem.markdown));

  const cdx = await run("codex");
  check("codex 변환 성공", cdx.ok, cdx.error?.message);
  check("codex 증분 뒤 완성본이 중복되지 않는다", body(cdx) === EXPECT, JSON.stringify(cdx.markdown));

  const oll = await run("ollama", { model: "시험모델" });
  check("ollama 변환 성공", oll.ok && body(oll) === EXPECT, JSON.stringify(oll.markdown));

  const noModel = await run("ollama", {});
  check("ollama 는 모델 이름이 없으면 거부한다", noModel.error?.code === "LLM_MODEL_REQUIRED", noModel.error?.code);

  const ollamaA = await run("ollama", { mode: "A", model: "시험모델" });
  check("ollama 는 모드 A 를 거부한다", ollamaA.error?.code === "LLM_MODE_A_UNSUPPORTED", ollamaA.error?.code);
  check(
    "모드 A 거부는 모드 B 재시도를 제안한다",
    ollamaA.error?.actions.includes("retry-mode-b"),
    JSON.stringify(ollamaA.error?.actions),
  );

  /* ── 4. 모드 A 격리 ──────────────────────────────── */
  console.log("\n모드 A 격리");

  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-llm-")).length;
  const probe = await run("claude", { fake: "probe", mode: "A" });
  check("모드 A 변환 성공", probe.ok, probe.error?.message);

  const entries = /ENTRIES=(.*)/.exec(probe.markdown)?.[1] ?? "";
  check("임시 폴더에 대상 1개만 있다", entries === "sample-ko.docx", entries);

  const cwd = /CWD=(.*)/.exec(probe.markdown)?.[1] ?? "";
  check("작업 디렉터리가 임시 폴더다", cwd.includes("markextract-llm-"), cwd);

  const args = /ARGS=(.*)/.exec(probe.markdown)?.[1] ?? "";
  check("원본 경로가 인자에 없다", !args.includes("test/fixtures"), args);
  check("원본 폴더 이름도 인자에 없다", !args.includes(dirname(fixture("sample-ko.docx"))), args);

  await sleep(200);
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-llm-")).length;
  check("종료 후 임시 폴더가 지워진다", after === before, `${before} → ${after}`);

  // 결정 17 — 형식을 읽지 못하면 조용히 모드 B 로 넘어가지 않는다. 실패로 두고
  // 사용자가 고르게 한다.
  const cannot = await run("claude", { fake: "cannot-read", mode: "A" });
  check("형식을 못 읽으면 실패로 처리한다", cannot.error?.code === "LLM_FORMAT_UNSUPPORTED", cannot.error?.code);
  check("표식이 본문으로 새지 않는다", cannot.markdown === "", JSON.stringify(cannot.markdown));
  check(
    "모드 B 재시도를 제안한다",
    cannot.error?.actions.includes("retry-mode-b"),
    JSON.stringify(cannot.error?.actions),
  );

  /* ── 5. 오류 진단 ────────────────────────────────── */
  console.log("\n오류 진단");

  const auth = await run("claude", { fake: "auth" });
  check("인증 만료를 가려낸다", auth.error?.code === "LLM_UNAUTHENTICATED", auth.error?.code);
  check("안내에 로그인 방법이 담긴다", (auth.error?.message ?? "").includes("로그인"), auth.error?.message);
  check(
    "앱이 대신 로그인할 수 없다는 점을 알린다",
    (auth.error?.message ?? "").includes("대신 로그인"),
    auth.error?.message,
  );

  const empty = await run("claude", { fake: "empty" });
  check("성공했는데 빈 결과면 실패로 처리한다", !empty.ok, JSON.stringify(empty.markdown));
  check("빈 결과 코드가 따로 있다", empty.error?.code === "LLM_EMPTY_OUTPUT", empty.error?.code);

  const stdoutErr = await run("claude", { fake: "stdout-error" });
  check("stdout 으로 흘린 진단을 집어낸다", (stdoutErr.error?.message ?? "").includes("overloaded"), stdoutErr.error?.message);

  const silent = await run("claude", { fake: "silent" });
  check("아무 출력도 없으면 재현 방법을 안내한다", silent.error?.code === "LLM_SILENT", silent.error?.code);
  check("재현할 명령이 안내에 담긴다", (silent.error?.message ?? "").includes("직접 실행"), silent.error?.message);

  process.env["PATH"] = "/nonexistent-dir-for-verify";
  clearCache();
  const notFound = await parseWithLlm(
    { filePath: fixture("sample-ko.docx"), options: { engine: "llm", provider: "claude" } },
    async () => ({ ok: true, markdown: "x", warnings: [], log: [], meta: { engine: "-", elapsedMs: 0 } }),
  );
  check("CLI 가 없으면 진단 리포트를 실어 실패한다", notFound.error?.code === "LLM_CLI_NOT_FOUND", notFound.error?.code);
  check("실패 메시지에 리포트가 담긴다", (notFound.error?.message ?? "").includes("확인할 것"));

  /* ── 6. 모드 B 의 로컬 단계 ──────────────────────── */
  console.log("\n모드 B");

  const localFail = await run("claude", {
    localStage: async () => ({
      ok: false,
      markdown: "",
      warnings: [],
      log: [],
      meta: { engine: "-", elapsedMs: 0 },
      error: { code: "X", message: "로컬이 먼저 깨졌다", actions: [] },
    }),
  });
  check("로컬 단계가 실패하면 LLM 을 부르지 않는다", localFail.error?.code === "LLM_LOCAL_STAGE_FAILED", localFail.error?.code);

  const modeB = await run("claude");
  check("모드 B 로그에 1단계가 남는다", modeB.log.some((e) => e.label === "1단계"), JSON.stringify(modeB.log));
  check("결과에 비결정성 경고가 붙는다", modeB.warnings.some((w) => w.code === "LLM_NONDETERMINISTIC"));

  /* ── 7. 후처리 ───────────────────────────────────── */
  console.log("\n후처리");

  const fenced = await run("claude", { fake: "fenced" });
  check("전체를 감싼 펜스가 벗겨진다", fenced.ok && !fenced.markdown.startsWith("```"), JSON.stringify(fenced.markdown));
  check("펜스 안의 본문이 온전하다", body(fenced) === EXPECT, JSON.stringify(fenced.markdown));

  // 본문 안의 정당한 코드 블록은 건드리지 않는다.
  const twoBlocks = "```js\nconst a = 1;\n```\n\n글\n\n```sh\nls\n```";
  check("코드 블록이 여럿이면 벗기지 않는다", stripOuterFence(twoBlocks) === twoBlocks);
  check("펜스가 아니면 그대로 둔다", stripOuterFence("# 제목\n") === "# 제목\n");

  /* ── 8. 취소 ─────────────────────────────────────── */
  console.log("\n취소");

  const controller = new AbortController();
  const hung = run("claude", { fake: "hang", signal: controller.signal });

  const countable = fakeProcesses() !== null;
  let spawned = false;
  for (let i = 0; i < 100 && countable; i++) {
    if (fakeProcesses() > 0) {
      spawned = true;
      break;
    }
    await sleep(100);
  }

  controller.abort();
  await sleep(250);
  const survivors = fakeProcesses();
  const cancelled = await hung;

  check("취소하면 실패로 끝난다", !cancelled.ok, JSON.stringify(cancelled.markdown));
  check("취소 사유가 남는다", (cancelled.error?.message ?? "").includes("취소"), cancelled.error?.message);
  if (!countable) console.log("  건너뜀  프로세스 확인 (이 플랫폼에서는 셀 수 없음)");
  else {
    check("취소 전에 CLI 가 돌고 있었다", spawned);
    check("취소가 CLI 프로세스를 즉시 죽인다", survivors === 0, `${survivors}개 남음`);
  }

  /* ── 9. 순수 함수 ────────────────────────────────── */
  console.log("\n진단 보조");

  check("인증 문구를 잡는다", looksUnauthenticated("Error: unauthenticated"));
  check("대소문자를 가리지 않는다", looksUnauthenticated("FAILED TO AUTHENTICATE"));
  check("관계없는 문구는 잡지 않는다", !looksUnauthenticated("file not found"));
  // 예산 4 — "뒤줄"(2자)은 들어가고 "아주 긴 앞줄"(7자)은 넘친다.
  check(
    "tailJoin 은 예산을 넘기면 앞줄을 버린다",
    tailJoin(["아주 긴 앞줄", "뒤줄"], 4) === "뒤줄",
    JSON.stringify(tailJoin(["아주 긴 앞줄", "뒤줄"], 4)),
  );
  check(
    "예산 안이면 둘 다 담는다",
    tailJoin(["앞", "뒤"], 100) === "앞\n뒤",
    JSON.stringify(tailJoin(["앞", "뒤"], 100)),
  );
  check(
    "종료 코드 0 + 빈 본문은 빈 결과로 분류된다",
    diagnose({ provider: "claude", command: "c", exitCode: 0, stderr: "", unparsed: [], empty: true }).code ===
      "LLM_EMPTY_OUTPUT",
  );

  /* ── 10. 인자 조합 ───────────────────────────────── */
  console.log("\n인자 조합");

  const claudeArgs = providerOf("claude").args({ mode: "B", model: "시험" }).join(" ");
  check("claude 는 stream-json 을 쓴다", claudeArgs.includes("--output-format stream-json"), claudeArgs);
  check("claude 는 --verbose 를 켠다", claudeArgs.includes("--verbose"));
  check("claude 는 사용자 설정을 끌어오지 않는다", claudeArgs.includes("--setting-sources project"));
  check("모델을 주면 --model 이 붙는다", claudeArgs.includes("--model 시험"));
  check(
    "모델이 없으면 --model 이 빠진다",
    !providerOf("claude").args({ mode: "B" }).join(" ").includes("--model"),
  );
  // 모드 A 격리는 인자에 달려 있다. 실수로 빠지면 LLM 이 볼 수 있는 범위가 넓어진다.
  const claudeA = providerOf("claude").args({ mode: "A" }).join(" ");
  check("모드 A 는 읽기 도구만 허용한다", claudeA.includes("--allowedTools Read Glob Grep"), claudeA);
  check("모드 A 는 쓰기·실행 도구를 막는다", claudeA.includes("--disallowedTools Bash Edit Write"), claudeA);
  check("모드 A 는 승인을 기다리지 않는다", claudeA.includes("--permission-mode dontAsk"), claudeA);
  check("모드 A 는 바깥 폴더를 더하지 않는다", !claudeA.includes("--add-dir"), claudeA);
  check("세션을 남기지 않는다", claudeA.includes("--no-session-persistence"), claudeA);
  check(
    "모드 B 에는 도구 허용 목록이 붙지 않는다",
    !providerOf("claude").args({ mode: "B" }).join(" ").includes("--allowedTools"),
  );
  check(
    "stream-json 입력 형식은 쓰지 않는다",
    !providerOf("claude").args({ mode: "B" }).join(" ").includes("--input-format"),
  );

  check("codex 는 읽기 전용 샌드박스다", providerOf("codex").args({ mode: "A" }).join(" ").includes("--sandbox read-only"));
  check("gemini 는 plan 승인 모드다", providerOf("gemini").args({ mode: "A" }).join(" ").includes("--approval-mode plan"));
  check("ollama 는 모드 A 를 지원하지 않는다고 선언한다", providerOf("ollama").supportsModeA === false);
} finally {
  process.env["PATH"] = realPath;
  delete process.env["MARKEXTRACT_FAKE"];
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`LLM 검증 실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("LLM 검증 통과");
