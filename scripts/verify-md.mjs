/**
 * Markdown 뷰어·편집기 검증 (build.38).
 *
 *   1. 읽기 — UTF-8 · BOM · CRLF · EUC-KR
 *   2. 고치지 않고 저장하면 바이트가 같다 (줄바꿈·BOM 유지)
 *   3. 저장은 새 파일을 써서 바꿔 단다 (원자적) — 남는 임시 파일이 없다
 *   4. 다른 프로그램이 고친 파일은 덮지 않는다 (force 일 때만)
 *   5. 큐: 직접 연 md 만 받는다 — 폴더 훑기 · 감시 폴더는 md 를 넣지 않는다
 *   6. 새 문서 → 다른 이름으로 저장, 다시 읽기
 *   7. 미리보기 — 원문의 HTML 은 글자로, javascript: 링크는 링크가 아니다
 *
 * Electron 없이 돌린다 (verify-queue.mjs 와 같은 방식).
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const work = mkdtempSync(join(tmpdir(), "markextract-verify-md-"));
const userData = join(work, "userData");
mkdirSync(userData, { recursive: true });

require.cache[require.resolve("electron")] = {
  exports: {
    app: { isPackaged: false, getPath: () => userData },
    ipcMain: { handle: () => {} },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    dialog: {},
    shell: {},
  },
};

const md = require(join(root, "out/main/md-file.js"));
const { renderMd } = require(join(root, "out/main/md-render.js"));
const queue = require(join(root, "out/main/queue.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const KO = "# 제목\n\n본문 한 줄\n- 항목\n";
// "한글" 의 EUC-KR 바이트
const EUCKR = Buffer.from([0x23, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x0a]);

const cases = {
  "lf.md": Buffer.from(KO, "utf8"),
  "crlf.md": Buffer.from(KO.replace(/\n/g, "\r\n"), "utf8"),
  "bom.md": Buffer.concat([BOM, Buffer.from(KO, "utf8")]),
  "bom-crlf.md": Buffer.concat([BOM, Buffer.from(KO.replace(/\n/g, "\r\n"), "utf8")]),
};

try {
  console.log("읽기·저장");
  for (const [name, bytes] of Object.entries(cases)) {
    const path = join(work, name);
    writeFileSync(path, bytes);
    const read = await md.readMd(path);
    check(`${name}: 편집기에는 \\n 로`, read.text === KO, JSON.stringify(read.text));

    const out = await md.saveMd(path, read.text, read.meta, false);
    check(`${name}: 고치지 않고 저장하면 바이트가 같다`, out.ok && readFileSync(path).equals(bytes));
  }

  const crlf = join(work, "crlf.md");
  const read = await md.readMd(crlf);
  await md.saveMd(crlf, `${read.text}새 줄\n`, read.meta, false);
  check("CRLF 파일에 더한 줄도 CRLF", readFileSync(crlf, "utf8").endsWith("- 항목\r\n새 줄\r\n"));

  const euc = join(work, "euckr.md");
  writeFileSync(euc, EUCKR);
  const eucRead = await md.readMd(euc);
  check("EUC-KR 을 읽는다", eucRead.text === "# 한글\n" && eucRead.meta.charset === "euc-kr", JSON.stringify(eucRead));
  await md.saveMd(euc, eucRead.text, eucRead.meta, false);
  check("EUC-KR 은 UTF-8 로 저장된다", readFileSync(euc).equals(Buffer.from("# 한글\n", "utf8")));

  console.log("원자적 저장");
  const atomic = join(work, "atomic.md");
  writeFileSync(atomic, "a\n");
  const before = statSync(atomic).ino;
  const a = await md.readMd(atomic);
  await md.saveMd(atomic, "b\n", a.meta, false);
  check("새 파일을 써서 바꿔 단다 (inode 가 바뀐다)", statSync(atomic).ino !== before);
  check("임시 파일이 남지 않는다", !readdirSync(work).some((f) => f.endsWith(".tmp")), readdirSync(work).join(","));

  // 저장할 자리에 폴더가 있으면 rename 이 실패한다. 임시 파일을 치워야 한다.
  const blocked = join(work, "blocked.md");
  mkdirSync(blocked);
  const fail = await md.saveMd(blocked, "x\n", md.NEW_META, true);
  check("저장 실패는 실패로 돌아온다", !fail.ok && !fail.conflict);
  check("실패해도 임시 파일이 남지 않는다", !readdirSync(work).some((f) => f.endsWith(".tmp")));

  console.log("바깥 수정");
  const ext = join(work, "external.md");
  writeFileSync(ext, "원래\n");
  const e = await md.readMd(ext);
  writeFileSync(ext, "다른 프로그램이 고침\n");
  utimesSync(ext, new Date(), new Date(Date.now() + 5000));
  const conflict = await md.saveMd(ext, "내 수정\n", e.meta, false);
  check("바깥에서 고친 파일은 덮지 않는다", !conflict.ok && conflict.conflict);
  check("덮지 않았다", readFileSync(ext, "utf8") === "다른 프로그램이 고침\n");
  const forced = await md.saveMd(ext, "내 수정\n", e.meta, true);
  check("force 면 덮는다", forced.ok && readFileSync(ext, "utf8") === "내 수정\n");

  console.log("큐");
  const folder = join(work, "folder");
  mkdirSync(folder);
  writeFileSync(join(folder, "inside.md"), "# 안\n");
  const byFolder = await queue.add([folder]);
  check("폴더를 훑을 때 md 는 넣지 않는다", byFolder.added === 0 && !queue.list().some((d) => d.kind === "md"));

  const watched = await queue.add([join(folder, "inside.md")], { md: false });
  check("감시 폴더(md: false)는 md 파일을 넣지 않는다", watched.added === 0);

  const direct = await queue.add([join(work, "lf.md")]);
  const doc = queue.list().find((d) => d.kind === "md");
  check("직접 연 md 는 들어온다", direct.added === 1 && doc !== undefined);
  check("변환 없이 바로 완료", doc?.status === "done" && doc.result?.ok === true);
  check("본문이 그대로", queue.markdownOf(doc?.id ?? "") === KO);

  writeFileSync(join(work, "lf.md"), "# 바뀜\n");
  const rev = doc?.rev;
  queue.reconvert(doc.id);
  await new Promise((r) => setTimeout(r, 200));
  const reloaded = queue.list().find((d) => d.id === doc.id);
  check("다시 읽기는 파일에서 새로 읽는다", queue.markdownOf(doc.id) === "# 바뀜\n");
  check("다시 읽으면 rev 가 오른다 (렌더러 본문 캐시)", reloaded.rev !== rev && reloaded.status === "done");

  const fresh = queue.newMd();
  check("새 문서는 경로가 없다", fresh.path === "" && fresh.status === "done");
  const noPath = await queue.saveMd(fresh.id, "x", null, false);
  check("경로 없는 새 문서는 그냥 저장하지 못한다", !noPath.ok);
  const target = join(work, "새 문서.md");
  const saved = await queue.saveMd(fresh.id, "# 새 글\n", target, false);
  const after = queue.list().find((d) => d.id === fresh.id);
  check("다른 이름으로 저장", saved.ok && readFileSync(target, "utf8") === "# 새 글\n");
  check("저장하면 이름·경로가 바뀐다", after.name === "새 문서.md" && after.path === target);
  const again = await queue.saveMd(fresh.id, "# 새 글\n둘째\n", null, false);
  check("그 뒤로는 그 파일에 저장 (바깥 수정 아님)", again.ok && readFileSync(target, "utf8").endsWith("둘째\n"));

  console.log("미리보기");
  const html = renderMd(
    '<script>alert(1)</script>\n\n[나쁜](javascript:alert(1))\n\n~~취소~~\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![그림](a.png)\n\n- 하나\n  - 중첩\n',
  );
  check("원문의 HTML 은 글자로", !html.includes("<script") && html.includes("&lt;script&gt;"));
  check("javascript: 링크는 링크가 아니다", !/href="javascript:/i.test(html));
  check("취소선·표·중첩 목록", html.includes("<s>취소</s>") && html.includes("<table>") && /<li>하나\s*<ul>/.test(html), html);
  check("그림은 참조 라벨", html.includes('class="imgref"') && !html.includes("<img"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nMarkdown 검증 실패 ${failures.length}건`);
  process.exit(1);
}
console.log("\nMarkdown 검증 통과");
