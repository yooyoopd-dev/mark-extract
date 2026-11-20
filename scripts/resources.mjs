/**
 * opendataloader 의 fat JAR 을 resources/lib/ 로 옮긴다.
 *
 * JAR 은 24MB 라 git 에 넣지 않는다. @opendataloader/pdf 를 devDependency 로 두고
 * package-lock 으로 버전을 고정한 뒤 빌드 때 꺼내 온다. npm 래퍼 자체는 런타임에
 * 쓰지 않는다 — 그 래퍼는 PATH 의 `java` 를 찾는데 우리는 동봉 JRE 를 쓴다
 * (docs/design/02-parser-adapters.md).
 */
import { copyFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 패키지의 exports 맵이 하위 경로를 막아 require.resolve 를 쓸 수 없다. 우리
// node_modules 안의 고정 위치라 직접 짚는다.
const from = join(root, "node_modules/@opendataloader/pdf/lib/opendataloader-pdf-cli.jar");
const to = join(root, "resources/lib/opendataloader-pdf-cli.jar");

if (!existsSync(from)) {
  console.error(`JAR 이 없습니다: ${from}\n먼저 \`npm ci\` 를 실행하세요.`);
  process.exit(1);
}

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`복사: resources/lib/opendataloader-pdf-cli.jar (${(statSync(to).size / 1024 / 1024).toFixed(1)}MB)`);
