/**
 * OCR(hybrid) 서버를 앱이 띄우고 관리한다 (build.37).
 *
 * build.32 는 서버를 터미널 창에 띄우고 손을 뗐다. 사내 PC 실측에서 두 가지가 드러났다.
 *
 *  - 서버는 **정상 기동했는데** 사용자는 실패로 읽었다. docling 이 시작할 때 무해한
 *    `ERROR - Preset … already registered` 를 찍고, 준비까지 몇 초(첫 실행은 모델을
 *    내려받느라 몇 분) 걸리는 사이 [연결 테스트] 를 누르면 실패가 나왔다. 준비를
 *    기다리는 장치가 없었던 것이다.
 *  - `--host` 를 넘기지 않아 서버가 `0.0.0.0` 에 열렸다 — 사내망의 다른 PC 가 이 서버에
 *    PDF 를 보낼 수 있었다. 패키지의 `hybrid_launcher.py` 는 `--host 127.0.0.1` 을 넘긴다.
 *
 * 그래서 이제 앱이 창 없이 띄우고, `/health` 가 답할 때까지 기다리고, 앱을 닫으면 끈다.
 * 준비 판정은 `/health` 하나로 한다 — 로그의 글자는 보지 않는다.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { isRemote, testHybrid } from "./hybrid-http";
import type { OcrStatus } from "../shared/doc";

/** 서버가 설치되는 실행 파일 이름 (pip 콘솔 스크립트). */
const EXE = "opendataloader-pdf-hybrid";
export const DEFAULT_URL = "http://127.0.0.1:5002";
const DEFAULT_PORT = "5002";
/** 인식할 글자. 설정에 없으므로 한국어·영어를 고정으로 쓴다. */
const LANG = "ko,en";

export const INSTALL_COMMAND = 'pip install "opendataloader-pdf[hybrid]"';

/** 0.5초마다 본다. 살아 있으면 곧바로 답한다(실측 13ms). */
const POLL_MS = 500;
/**
 * 준비를 기다리는 한도. 첫 실행은 docling·EasyOCR 모델을 내려받는다 — 사내망 속도에
 * 따라 몇 분이 걸릴 수 있어 넉넉히 잡는다. 그동안 화면에 경과와 마지막 로그를 보인다.
 */
const READY_TIMEOUT_MS = 10 * 60_000;
/** 실패했을 때 보여 줄 로그 꼬리 줄 수 */
const TAIL_LINES = 30;

/** 비어 있으면 기본 주소. 빈 칸이 "OCR 안 씀" 이던 시절의 설정 파일도 그대로 동작한다. */
export const effectiveUrl = (hybridUrl: string): string => hybridUrl.trim() || DEFAULT_URL;

/** 설정의 서버 주소에서 포트만 뽑는다. */
export function serverPort(hybridUrl: string): string {
  try {
    const port = new URL(effectiveUrl(hybridUrl)).port;
    return port === "" ? DEFAULT_PORT : port;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * 구동 인자. `--host 127.0.0.1` 이 빠지면 서버가 0.0.0.0 에 열린다.
 *
 * `--force-ocr` 는 텍스트 레이어가 있어도 인식하게 한다. 스캔 판정이 놓친 페이지를
 * 위해 넣는다 (02 문서의 hybrid 절).
 */
export function serverArgs(hybridUrl: string): string[] {
  return ["--host", "127.0.0.1", "--port", serverPort(hybridUrl), "--force-ocr", "--ocr-lang", LANG];
}

/** 화면에 글로 띄울 한 줄. 사용자가 직접 띄울 때 복사해 쓴다. */
export const serverCommandLine = (hybridUrl: string): string =>
  [EXE, ...serverArgs(hybridUrl)].map((arg) => (arg === LANG ? `"${arg}"` : arg)).join(" ");

/* ── 상태 ─────────────────────────────────────────────── */

export const ocrEvents = new EventEmitter();

let status: OcrStatus = { phase: "off", detail: "꺼져 있습니다.", url: DEFAULT_URL, managed: false };
let child: ChildProcess | null = null;
let log: string[] = [];
/** 지금 진행 중인 시작. 여러 문서가 동시에 OCR 을 요청해도 서버는 하나만 띄운다. */
let starting: Promise<OcrStatus> | null = null;

/** 검증 전용 — 실제 실행 파일 대신 가짜 서버를 띄운다 (scripts/verify-ocr.mjs). */
let command: { file: string; prefix: string[] } = { file: EXE, prefix: [] };
let readyTimeoutMs = READY_TIMEOUT_MS;
export function setCommandForVerify(file: string, prefix: string[] = [], timeoutMs = READY_TIMEOUT_MS): void {
  command = { file, prefix };
  readyTimeoutMs = timeoutMs;
}

function set(next: OcrStatus): OcrStatus {
  status = next;
  ocrEvents.emit("changed", status);
  return status;
}

export const ocrStatus = (): OcrStatus => status;

const lastLine = (): string => [...log].reverse().find((l) => l.trim() !== "")?.trim().slice(0, 160) ?? "";
const tail = (): string => log.slice(-TAIL_LINES).join("\n").trim();

function collect(chunk: Buffer): void {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim() !== "") log.push(line);
  if (log.length > 500) log = log.slice(-TAIL_LINES * 2);
  // 시작 중이면 마지막 줄을 화면에 흘린다 — 모델을 내려받는 몇 분이 멈춘 것처럼 보이지 않게.
  if (status.phase === "starting") set({ ...status, lastLine: lastLine() });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 서버가 준비될 때까지 기다린다. 없으면 띄운다.
 *
 * - 이미 `/health` 가 답하면 띄우지 않는다 (앱 밖에서 떠 있는 서버)
 * - 원격 주소면 띄우지 않고 연결만 본다
 * - 준비 전에 프로세스가 끝나면 실패와 로그 꼬리
 */
export async function ensureOcrServer(hybridUrl: string, signal?: AbortSignal): Promise<OcrStatus> {
  const url = effectiveUrl(hybridUrl);
  // 켜 둔 서버가 그 사이 죽었을 수 있다. 확인은 싸다.
  if (status.phase === "on" && status.url === url && (await testHybrid(url)).ok) return status;

  // 기다리던 문서가 취소돼도 서버 시작은 멈추지 않는다 — 다른 문서가 같은 서버를
  // 기다리고 있을 수 있고, 반쯤 뜬 서버를 버리면 상태가 "켜는 중" 에 멈춘다.
  const pending = starting ?? start(url);
  if (!signal) return pending;
  return Promise.race([pending, new Promise<OcrStatus>((resolve) => signal.addEventListener("abort", () => resolve(status)))]);
}

/** 설정의 [켜기]. 기다리지 않고 시작만 건다 — 진행은 방송으로 화면에 간다. */
export function startOcrServer(hybridUrl: string): OcrStatus {
  if (status.phase !== "starting") void (starting ?? start(effectiveUrl(hybridUrl)));
  return status;
}

function start(url: string): Promise<OcrStatus> {
  starting = run(url).finally(() => {
    starting = null;
  });
  return starting;
}

async function run(url: string): Promise<OcrStatus> {
  const already = await testHybrid(url);
  if (already.ok) {
    return set({ phase: "on", detail: "켜져 있습니다 (앱 밖에서 실행 중).", url, managed: false });
  }
  if (isRemote(url)) {
    return set({ phase: "failed", detail: `원격 OCR 서버에 연결하지 못했습니다: ${already.detail}`, url, managed: false });
  }

  // 앞서 띄운 서버가 살아는 있는데 답이 없으면(멈춤) 정리하고 새로 띄운다.
  if (child) {
    const stale = child;
    child = null;
    stale.kill();
  }
  log = [];
  const since = Date.now();
  set({ phase: "starting", detail: "OCR 서버를 켜는 중입니다.", url, managed: true, since });

  // 콜백에서 채우는 값은 객체에 담는다. let 으로 두면 TypeScript 가 null 로 좁혀 버린다.
  const seen: { exited: string | null; spawnError: NodeJS.ErrnoException | null } = { exited: null, spawnError: null };
  try {
    child = spawn(command.file, [...command.prefix, ...serverArgs(url)], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // UTF-8 모드로 띄운다. 그러지 않으면 cp949 PC 에서 서버가 UTF-8 자식 프로세스로
      // 한 번 더 뜬다 (hybrid_server.py 의 _reexec_with_utf8_if_needed). 프로세스가
      // 하나여야 앱이 끌 때 확실히 꺼진다.
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
  } catch (error) {
    return set(failure(url, error as NodeJS.ErrnoException));
  }

  const proc = child;
  proc.stdout?.on("data", collect);
  proc.stderr?.on("data", collect);
  // 실행 파일이 없으면(ENOENT) spawn 은 던지지 않고 error 이벤트를 낸다.
  proc.once("error", (error: NodeJS.ErrnoException) => (seen.spawnError = error));
  proc.once("exit", (code, sig) => {
    seen.exited = `종료 코드 ${code ?? sig}`;
    if (child === proc) child = null;
    // 켜져 있던 서버가 죽었다. 다음 OCR 요청이 다시 띄운다.
    if (status.phase === "on" && status.managed) {
      set({ phase: "failed", detail: `OCR 서버가 멈췄습니다 (${seen.exited}).`, url, managed: true, tail: tail() });
    }
  });

  while (Date.now() - since < readyTimeoutMs) {
    await wait(POLL_MS);
    if (seen.spawnError) return set(failure(url, seen.spawnError));
    // 사용자가 [끄기] 를 눌렀다.
    if (status.phase === "off") return status;
    if (seen.exited !== null) {
      return set({
        phase: "failed",
        detail: `OCR 서버가 준비되기 전에 끝났습니다 (${seen.exited}).`,
        url,
        managed: true,
        tail: tail(),
      });
    }
    if ((await testHybrid(url)).ok) {
      return set({ phase: "on", detail: "켜져 있습니다.", url, managed: true });
    }
  }

  stopOcrServer();
  return set({
    phase: "failed",
    detail: `OCR 서버가 ${Math.round(readyTimeoutMs / 60_000)}분 안에 준비되지 않았습니다.`,
    url,
    managed: true,
    tail: tail(),
  });
}

function failure(url: string, error: NodeJS.ErrnoException): OcrStatus {
  if (error.code === "ENOENT") {
    return {
      phase: "failed",
      detail: "OCR 서버가 설치되어 있지 않습니다. 아래 명령으로 설치한 뒤 다시 켜세요.",
      url,
      managed: true,
      missing: true,
    };
  }
  return { phase: "failed", detail: `OCR 서버를 띄우지 못했습니다: ${error.message}`, url, managed: true };
}

/** 앱이 띄운 서버만 끈다. 앱 밖에서 떠 있던 서버는 건드리지 않는다. */
export function stopOcrServer(): void {
  if (child) {
    // exit 이벤트가 "멈췄습니다" 로 적지 않게 먼저 상태를 내린다 (아래).
    const proc = child;
    child = null;
    proc.kill();
  }
  if (status.phase === "on" || status.phase === "starting") {
    set({ phase: "off", detail: "꺼져 있습니다.", url: status.url, managed: false });
  }
}

/** 앱을 켤 때 한 번 — 이미 떠 있는 서버가 있으면 그것을 쓴다. 띄우지는 않는다. */
export async function detectOcrServer(hybridUrl: string): Promise<OcrStatus> {
  const url = effectiveUrl(hybridUrl);
  const h = await testHybrid(url);
  if (h.ok) return set({ phase: "on", detail: "켜져 있습니다 (앱 밖에서 실행 중).", url, managed: false });
  return set({ phase: "off", detail: "꺼져 있습니다.", url, managed: false });
}
