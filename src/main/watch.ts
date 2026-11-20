/**
 * 감시 폴더. 새로 들어온 지원 문서를 큐에 넣는다.
 *
 * fs.watch 는 한 번의 파일 저장에도 이벤트를 여러 번 내고, 복사 중인 파일은 아직
 * 크기가 0 이거나 잠겨 있을 수 있다. 그래서 잠깐 모았다가(debounce) 크기가 안정된
 * 뒤에 넣는다.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { add } from "./queue";
import { settings, updateSettings } from "./settings";
import type { WatchFolder } from "../shared/doc";

const DEBOUNCE_MS = 700;
/** 복사가 끝났는지 보려고 크기를 두 번 잰다. */
const SETTLE_MS = 400;

const watchers = new Map<string, FSWatcher>();
const pendingPaths = new Set<string>();
let timer: NodeJS.Timeout | null = null;

async function settled(path: string): Promise<boolean> {
  try {
    const first = (await stat(path)).size;
    if (first === 0) return false;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return (await stat(path)).size === first;
  } catch {
    return false;
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const paths = [...pendingPaths];
    pendingPaths.clear();

    void (async () => {
      const ready: string[] = [];
      for (const path of paths) if (await settled(path)) ready.push(path);
      if (ready.length > 0) await add(ready);
    })();
  }, DEBOUNCE_MS);
}

function start(folder: string): void {
  if (watchers.has(folder)) return;

  try {
    const watcher = watch(folder, { persistent: false }, (_event, name) => {
      if (typeof name === "string" && name.trim() !== "") pendingPaths.add(join(folder, name));
      schedule();
    });
    watcher.on("error", () => stop(folder));
    watchers.set(folder, watcher);
  } catch {
    // 접근할 수 없는 폴더는 조용히 넘긴다. 설정에는 남아 있어 사용자가 지울 수 있다.
  }
}

function stop(folder: string): void {
  watchers.get(folder)?.close();
  watchers.delete(folder);
}

export function restoreWatches(): void {
  for (const folder of settings().watch) start(folder.path);
}

export async function addWatch(path: string): Promise<WatchFolder[]> {
  const current = settings().watch;
  if (!current.some((w) => w.path === path)) {
    const next = [...current, { path, addedAt: Date.now() }];
    updateSettings({ watch: next });
    start(path);
    // 이미 들어 있는 것도 한 번 훑는다.
    await add([path]);
  }
  return settings().watch;
}

export function removeWatch(path: string): WatchFolder[] {
  stop(path);
  updateSettings({ watch: settings().watch.filter((w) => w.path !== path) });
  return settings().watch;
}

export function stopAll(): void {
  for (const folder of [...watchers.keys()]) stop(folder);
}
