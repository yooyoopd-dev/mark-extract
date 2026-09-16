/** 렌더러 정적 파일(html/css)을 out/renderer 로 옮긴다. tsc 는 .ts 만 다룬다. */
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const to = join(root, "out/renderer");

mkdirSync(to, { recursive: true });
cpSync(join(root, "src/renderer/index.html"), join(to, "index.html"));
cpSync(join(root, "src/renderer/styles"), join(to, "styles"), { recursive: true });
console.log("복사: out/renderer/{index.html, styles/}");
