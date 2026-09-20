/**
 * 설정 영속화. %APPDATA%/MarkExtract/settings.json (docs/design/05-packaging.md).
 *
 * portable 실행이라도 설정은 남아야 한다. 암호는 저장하지 않는다 — 변환 1건 동안
 * 메모리에만 둔다.
 */
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../shared/doc";

const DEFAULTS: Settings = {
  concurrency: 1,
  outputDir: null,
  frontmatter: true,
  theme: "system",
  watch: [],

  defaultEngine: "local",
  provider: "claude",
  model: "",
  inputMode: "B",
  imageOutput: "external",
  llmTimeoutMin: 30,
  language: "keep",
  maxFileSizeMb: 500,
  ollamaUrl: "http://127.0.0.1:11434",
  hybridUrl: "http://127.0.0.1:5002",
  ocrByDefault: false,
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/**
 * 파일에서 읽은 값을 쓸 수 있는 모양으로 다듬는다.
 *
 * 설정 파일은 사용자가 손으로 고칠 수 있고 판올림을 건너뛴 오래된 파일일 수도 있다.
 * 값 하나가 이상하다고 앱이 뜨지 못하면 안 되므로, 아는 범위로 끌어오고 모르는
 * 값은 기본값으로 되돌린다.
 */
function normalize(raw: Settings): Settings {
  return {
    ...raw,
    concurrency: clamp(raw.concurrency, 1, 4, DEFAULTS.concurrency),
    frontmatter: typeof raw.frontmatter === "boolean" ? raw.frontmatter : DEFAULTS.frontmatter,
    theme: oneOf(raw.theme, ["system", "light", "dark"] as const, DEFAULTS.theme),
    watch: Array.isArray(raw.watch) ? raw.watch : [],

    defaultEngine: oneOf(raw.defaultEngine, ["local", "llm"] as const, DEFAULTS.defaultEngine),
    provider: oneOf(raw.provider, ["claude", "gemini", "codex", "ollama"] as const, DEFAULTS.provider),
    model: typeof raw.model === "string" ? raw.model.trim().slice(0, 200) : DEFAULTS.model,
    inputMode: oneOf(raw.inputMode, ["A", "B"] as const, DEFAULTS.inputMode),
    imageOutput: oneOf(raw.imageOutput, ["off", "embedded", "external"] as const, DEFAULTS.imageOutput),
    // 1분~3시간. 0 이나 음수가 들어오면 변환이 즉시 실패한다.
    llmTimeoutMin: clamp(raw.llmTimeoutMin, 1, 180, DEFAULTS.llmTimeoutMin),
    language: oneOf(raw.language, ["ko", "en", "keep"] as const, DEFAULTS.language),
    maxFileSizeMb: clamp(raw.maxFileSizeMb, 1, 10_000, DEFAULTS.maxFileSizeMb),
    ollamaUrl: typeof raw.ollamaUrl === "string" && raw.ollamaUrl.trim() !== ""
      ? raw.ollamaUrl.trim()
      : DEFAULTS.ollamaUrl,
    // 빈 문자열을 기본값으로 되돌리지 않는다 — "OCR 안 씀" 이 정당한 상태다.
    hybridUrl: typeof raw.hybridUrl === "string" ? raw.hybridUrl.trim() : DEFAULTS.hybridUrl,
    ocrByDefault: typeof raw.ocrByDefault === "boolean" ? raw.ocrByDefault : DEFAULTS.ocrByDefault,
  };
}

const file = (): string => join(app.getPath("userData"), "settings.json");

let cache: Settings | null = null;

export function settings(): Settings {
  if (cache) return cache;

  try {
    const raw: unknown = JSON.parse(readFileSync(file(), "utf8"));
    // 파일이 오래되었거나 손상되어도 앱이 뜨지 못하면 안 된다. 아는 키만 덮어쓴다.
    cache = normalize({ ...DEFAULTS, ...(raw as Partial<Settings>) });
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = normalize({ ...settings(), ...patch });
  cache = next;

  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // 저장에 실패해도 이번 실행은 이어간다. 다음 실행에서 기본값으로 돌아갈 뿐이다.
  }
  return next;
}
