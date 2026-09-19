/**
 * jlink 로 경량 JRE 를 만들어 resources/jre 에 둔다.
 *
 * opendataloader 는 Java CLI 라 JRE 가 있어야 하는데, npm 패키지는 JAR 만 동봉하고
 * PATH 의 `java` 를 찾는다. 사용자 PC 에 Java 가 없어도 되게 하려면 우리가 넣어야
 * 한다 (docs/design/05-packaging.md).
 *
 * 돌리는 플랫폼의 JRE 가 나온다 — 리눅스에서는 리눅스용, Windows 러너에서는
 * Windows 용. 같은 스크립트를 쓴다.
 */
import { spawnSync } from "node:child_process";
import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources/jre");

/**
 * `jdeps --multi-release 21 --print-module-deps --ignore-missing-deps` 로 구한 값.
 * 매 빌드마다 jdeps 를 돌리지 않는 이유는 결과가 환경에 따라 흔들리기 때문이다.
 *
 * 뒤의 둘은 jdeps 가 잡지 못하는 몫이다 — --ignore-missing-deps 결과는 하한선이라
 * 런타임에 더 필요할 수 있다.
 *   jdk.unsupported  sun.misc.Unsafe 를 쓰는 라이브러리
 *   jdk.crypto.ec    암호가 걸린 PDF
 */
const MODULES = [
  "java.base",
  "java.compiler",
  "java.desktop",
  "java.management",
  "java.sql",
  "jdk.unsupported",
  "jdk.crypto.ec",
];

function dirSize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
  }
  return total;
}

rmSync(out, { recursive: true, force: true });

const run = spawnSync(
  "jlink",
  [
    "--add-modules", MODULES.join(","),
    "--strip-debug",
    "--no-header-files",
    "--no-man-pages",
    "--compress=zip-6",
    "--output", out,
  ],
  { stdio: "inherit" },
);

if (run.error?.code === "ENOENT") {
  console.error("jlink 를 찾지 못했습니다. JDK 17 이상을 설치하고 PATH 에 넣으세요.");
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);

const java = join(out, "bin", process.platform === "win32" ? "java.exe" : "java");
if (!existsSync(java)) {
  console.error(`jlink 는 끝났으나 ${java} 가 없습니다.`);
  process.exit(1);
}

console.log(`생성: resources/jre (${(dirSize(out) / 1024 / 1024).toFixed(0)}MB, 모듈 ${MODULES.length}개)`);
