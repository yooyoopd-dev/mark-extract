/**
 * PDF → Markdown (docs/design/02-parser-adapters.md).
 *
 * opendataloader-pdf 는 Java CLI 라 링크할 수 없고 프로세스로 띄운다. npm 패키지의
 * 래퍼(@opendataloader/pdf)는 PATH 의 `java` 를 찾는데, 우리는 동봉한 JRE 를 써야
 * 하므로 래퍼를 거치지 않고 JAR 을 직접 실행한다.
 *
 * 결과는 stdout 이 아니라 파일로 받는다. --to-stdout 플래그가 있지만 Windows 콘솔
 * 코드페이지의 영향을 받을 여지가 있고, --image-output external 로 뽑은 이미지도
 * 어차피 디렉터리 단위로 회수해야 한다.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { normalizeMarkdown } from "../normalize";
import type { DocOptions, LogEntry, ParseRequest, ParseResult, Warning } from "../../shared/parse";

const ENGINE = "로컬 · opendataloader";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** 이 CLI 에는 --version 이 없다. 이걸로 확인하면 정상 설치를 고장으로 오판한다. */
const PROBE_FLAG = "--export-options";

interface JavaTarget {
  readonly command: string;
  /** 동봉 JRE 를 썼는지. 로그에 남겨 Java 미설치 환경 문제를 가려낸다. */
  readonly bundled: boolean;
}

function resourcesRoot(): string {
  // 패키징된 앱에서는 process.resourcesPath, 개발 중에는 저장소 루트의 resources/.
  return app?.isPackaged ? process.resourcesPath : join(__dirname, "../../../resources");
}

/** 동봉 JRE 를 먼저 쓰고, 없으면 PATH 의 java 로 물러난다(개발 편의). */
export function resolveJava(): JavaTarget {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const bundled = join(resourcesRoot(), "jre", "bin", exe);
  return existsSync(bundled) ? { command: bundled, bundled: true } : { command: "java", bundled: false };
}

export function resolveJar(): string {
  return join(resourcesRoot(), "lib", "opendataloader-pdf-cli.jar");
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runJava(args: readonly string[], signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  const java = resolveJava();

  return new Promise((resolve, reject) => {
    const child = spawn(
      java.command,
      [
        "-Djava.awt.headless=true",
        // Windows 기본 코드페이지(949)를 타지 않게 한다.
        "-Dfile.encoding=UTF-8",
        "-jar",
        resolveJar(),
        ...args,
      ],
      // 셸을 거치지 않는다 — 경로에 한글·공백이 있어도 안전하다.
      { shell: false },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = () => child.kill("SIGKILL");
    const onAbort = () => {
      kill();
      finish(() => reject(new Error("변환이 취소되었습니다.")));
    };
    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(`변환이 ${Math.round(timeoutMs / 1000)}초를 넘겨 중단되었습니다.`)));
    }, timeoutMs);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ENOENT"
            ? new Error(
                java.bundled
                  ? `동봉된 Java 를 실행하지 못했습니다: ${java.command}`
                  : "Java 를 찾지 못했습니다. 동봉 JRE 가 빠진 빌드이거나 PATH 에 java 가 없습니다.",
              )
            : error,
        ),
      );
    });
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

/**
 * CLI 가 살아 있는지 본다. --export-options 는 옵션 목록을 JSON 으로 내놓고 0 으로
 * 끝난다. 문자열을 뒤지는 것보다 JSON 을 파싱해 보는 쪽이 확실하다.
 */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { code, stdout, stderr } = await runJava([PROBE_FLAG], undefined, 90_000);
    if (code !== 0) return { ok: false, detail: `${PROBE_FLAG} 가 ${code} 로 끝났습니다: ${stderr.trim()}` };

    const parsed: unknown = JSON.parse(stdout);
    const options = (parsed as { options?: unknown }).options;
    if (!Array.isArray(options) || options.length === 0) {
      return { ok: false, detail: "옵션 목록이 비어 있습니다." };
    }
    return { ok: true, detail: `옵션 ${options.length}개 확인` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function buildArgs(filePath: string, outputDir: string, options: DocOptions = {}): string[] {
  const args = [
    filePath,
    "--format", "markdown",
    // 줄 경계를 살려 받는다. 문단 잇기는 normalize.ts 가 CJK 를 봐 가며 한다.
    "--keep-line-breaks",
    "--quiet",
    "--output-dir", outputDir,
  ];

  // --space-ratio 는 노출하지 않는다. 올리면 한글 문제는 그대로인 채 정당한
  // 공백까지 사라진다 (normalize.ts 주석 참조).
  if (options.tableMethod) args.push("--table-method", options.tableMethod);
  if (options.readingOrder) args.push("--reading-order", options.readingOrder);
  if (options.includeHeaderFooter) args.push("--include-header-footer");
  if (options.imageOutput) args.push("--image-output", options.imageOutput);
  if (options.pages) args.push("--pages", options.pages);
  if (options.password) args.push("--password", options.password);

  return args;
}

/** stderr 의 WARNING 줄을 사용자에게 보일 경고로 옮긴다. */
function collectWarnings(stderr: string): Warning[] {
  const warnings: Warning[] = [];
  for (const line of stderr.split("\n")) {
    const match = /WARNING:\s*(.+)$/.exec(line);
    if (match?.[1]) warnings.push({ code: "ENGINE_WARNING", message: match[1].trim() });
  }
  return warnings;
}

export async function parsePdf(request: ParseRequest): Promise<ParseResult> {
  const started = Date.now();
  const java = resolveJava();

  // 변환 1건마다 새 임시 디렉터리. 원본 옆에는 아무것도 쓰지 않는다.
  const dir = await mkdtemp(join(tmpdir(), "markextract-"));

  const log: LogEntry[] = [
    { label: "엔진", value: ENGINE },
    { label: "Java", value: java.bundled ? `동봉 JRE (${java.command})` : `시스템 java (${java.command})` },
  ];

  try {
    const args = buildArgs(request.filePath, dir, request.options);
    // 암호는 로그에 남기지 않는다.
    log.push({ label: "인자", value: args.map((a) => (a === request.options?.password ? "***" : a)).join(" ") });

    const { code, stderr } = await runJava(args, request.signal);
    const elapsedMs = Date.now() - started;

    if (code !== 0) {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "stderr", value: stderr.trim() || "(없음)" }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: "ENGINE_FAILED",
          message: `변환 엔진이 ${code} 로 끝났습니다.`,
          actions: ["retry-plain"],
        },
      };
    }

    const produced = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".md"));
    const first = produced[0];
    if (first === undefined) {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "stderr", value: stderr.trim() || "(없음)" }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: "NO_OUTPUT",
          message: "변환 엔진이 결과 파일을 내놓지 않았습니다.",
          actions: ["retry-plain"],
        },
      };
    }

    const markdown = normalizeMarkdown(await readFile(join(dir, first), "utf8"));

    if (markdown.trim() === "") {
      return {
        ok: false,
        markdown: "",
        warnings: [],
        log: [...log, { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` }],
        meta: { engine: ENGINE, elapsedMs },
        error: {
          code: "EMPTY_OUTPUT",
          message: "추출된 텍스트가 없습니다. 스캔 문서일 수 있습니다.",
          actions: ["retry-with-ocr", "retry-plain"],
        },
      };
    }

    return {
      ok: true,
      markdown,
      warnings: collectWarnings(stderr),
      log: [...log, { label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` }],
      meta: { engine: ENGINE, elapsedMs },
    };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine: ENGINE, elapsedMs: Date.now() - started },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  } finally {
    // 성공·실패·취소 어느 경로로 끝나든 지운다.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
