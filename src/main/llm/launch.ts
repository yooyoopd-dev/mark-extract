/**
 * CLI 를 실제로 띄운다 (docs/design/03-llm-engine.md#windows-셰임).
 *
 * Windows 에서 npm 전역 설치는 `gemini.cmd` 같은 배치 셰임을 깐다. Node 18.20.2
 * 이후(CVE-2024-27980) `.cmd`·`.bat` 를 shell 없이 spawn 하면 EINVAL 을 던진다.
 * build.10 을 Windows 에서 돌린 결과가 정확히 그것이었다 — `spawn EINVAL`.
 * 그래서 셰임만 cmd.exe 를 통해 부른다.
 *
 * `shell: true` 는 쓰지 않는다. 그건 Node 가 만든 명령줄에 인자를 그대로 이어
 * 붙여, 모델 이름이나 한글 경로에 `&` 하나만 있어도 명령이 갈라진다. 명령줄을
 * 직접 만들고 인용한다 — 규칙은 cross-spawn 을 따랐다 (docs/design/ATTRIBUTION.md).
 */
import { spawn } from "node:child_process";

/** cmd.exe 를 거쳐야 하는 파일. */
const SHIM = /\.(cmd|bat)$/i;

/** 셰임인가. resolve.ts 가 리포트 문구를 고를 때 같은 규칙을 쓴다. */
export const isShim = (path: string): boolean => SHIM.test(path);

/** CLI 가 살아 있는지 보는 데 이만큼이면 충분하다. 설정 화면이 기다리는 시간이다. */
/**
 * 탐지용 `--version` 을 기다리는 시간.
 *
 * 5초였으나 실측에서 부족했다. 이 컨테이너에서 gemini·codex 를 그날 처음 띄웠을
 * 때 둘 다 5초 안에 답하지 못했고(두 번째부터는 각각 1.5초·0.05초), 사내 PC 는
 * 백신이 큰 JS 번들을 전수 검사하므로 더 느릴 수 있다. 여기서 모자라면 설정
 * 화면이 멀쩡히 도는 CLI 를 "실행하지 못했습니다"로 적는다.
 */
const PROBE_MS = 15000;

/**
 * 인자 하나를 cmd.exe 용으로 인용한다.
 *
 * 두 겹이다. 안쪽은 CommandLineToArgvW 규칙(따옴표 앞 역슬래시를 두 배로 늘리고
 * 전체를 따옴표로 감싼다), 바깥쪽은 cmd.exe 파서용 `^`. cmd 가 `^` 를 벗겨 내면
 * 안쪽 인용이 그대로 남아 CLI 가 원래 인자를 받는다.
 *
 * `%` 는 막지 못한다 — cmd 는 `^%` 도 확장한다. 모델 이름이나 경로에 `%VAR%` 가
 * 있으면 확장된다. cross-spawn 도 같은 한계를 가진다.
 */
function quote(arg: string): string {
  const inner = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${inner}"`.replace(/[<>"^|&?*]/g, "^$&");
}

export interface Launch {
  readonly file: string;
  readonly args: readonly string[];
  /** cmd.exe 에 넘길 때는 Node 가 다시 인용하면 안 된다. */
  readonly verbatim: boolean;
}

/**
 * 무엇을 어떻게 spawn 할지 정한다. 셰임이 아니면 손대지 않고 그대로 통과시킨다.
 *
 * platform 을 인자로 받는 이유는 리눅스에서 Windows 경로를 단언하기 위해서다
 * (scripts/verify-llm.mjs).
 */
export function launchSpec(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Launch {
  if (platform !== "win32" || !SHIM.test(command)) {
    return { file: command, args: [...args], verbatim: false };
  }

  const line = [command, ...args].map(quote).join(" ");
  return {
    file: process.env["ComSpec"] ?? "cmd.exe",
    // /d 는 AutoRun 레지스트리 항목을 건너뛰고, /s 는 바깥 따옴표 한 겹을 벗긴다.
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
  };
}

/** spawn 옵션을 한곳에서 만든다. 실행 경로가 둘(변환·탐지)이라 어긋나면 안 된다. */
export function spawnOptions(launch: Launch, cwd?: string): Parameters<typeof spawn>[2] {
  // windowsHide 의 Node 기본값은 false 다. GUI 앱이 cmd.exe 를 부르면 변환하는
  // 내내 콘솔 창이 떠 있게 된다.
  const options: Parameters<typeof spawn>[2] = { shell: false, windowsHide: true };
  if (launch.verbatim) options.windowsVerbatimArguments = true;
  if (cwd !== undefined) options.cwd = cwd;
  return options;
}

export interface Probe {
  readonly ok: boolean;
  /** 화면에 그대로 띄운다. 성공이면 버전, 실패면 사유. */
  readonly detail: string;
}

/**
 * CLI 를 실제로 한 번 띄워 본다.
 *
 * 파일이 있는지만 보던 탐지가 이번 결함(`gemini.cmd` 를 찾아 놓고 실행하지
 * 못함)을 그대로 통과시켰다. 찾은 것과 도는 것은 다른 사실이라 따로 확인한다.
 */
export function probeCli(command: string, timeoutMs = PROBE_MS): Promise<Probe> {
  return new Promise((resolve) => {
    const launch = launchSpec(command, ["--version"]);
    const child = spawn(launch.file, [...launch.args], spawnOptions(launch));

    let out = "";
    let settled = false;
    const finish = (probe: Probe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, detail: `${Math.round(timeoutMs / 1000)}초 안에 --version 에 답하지 않았습니다.` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (out += chunk));
    child.stderr?.on("data", (chunk: string) => (out += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ ok: false, detail: `${error.code ?? "오류"} — ${error.message}` });
    });
    child.on("close", (code) => {
      const first = out.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
      finish(
        code === 0
          ? { ok: true, detail: first === "" ? "실행됨" : first.slice(0, 120) }
          : { ok: false, detail: `--version 이 ${code} 로 끝났습니다${first === "" ? "" : `: ${first.slice(0, 120)}`}` },
      );
    });

    // 입력을 기다리며 매달리지 않게 곧바로 닫는다.
    child.stdin?.end();
  });
}
