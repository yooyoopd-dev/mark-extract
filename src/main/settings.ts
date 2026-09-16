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
};

const file = (): string => join(app.getPath("userData"), "settings.json");

let cache: Settings | null = null;

export function settings(): Settings {
  if (cache) return cache;

  try {
    const raw: unknown = JSON.parse(readFileSync(file(), "utf8"));
    // 파일이 오래되었거나 손상되어도 앱이 뜨지 못하면 안 된다. 아는 키만 덮어쓴다.
    cache = { ...DEFAULTS, ...(raw as Partial<Settings>) };
    cache.concurrency = Math.min(Math.max(Math.trunc(cache.concurrency) || 1, 1), 4);
    if (!Array.isArray(cache.watch)) cache.watch = [];
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...settings(), ...patch };
  next.concurrency = Math.min(Math.max(Math.trunc(next.concurrency) || 1, 1), 4);
  cache = next;

  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // 저장에 실패해도 이번 실행은 이어간다. 다음 실행에서 기본값으로 돌아갈 뿐이다.
  }
  return next;
}
