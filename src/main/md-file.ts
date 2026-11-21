/**
 * Markdown 파일 읽기·저장 (build.38 — 뷰어·편집기).
 *
 * 변환하지 않는다. 읽은 그대로 보이고, 고친 것을 그 파일에 되쓴다. 지켜야 할 것은
 * 세 가지다.
 *
 *  - 고치지 않고 저장하면 바이트가 그대로여야 한다 — 줄바꿈(CRLF/LF)과 BOM 을 기억한다
 *  - 저장이 도중에 실패해도 원본이 반쯤 쓰인 채로 남지 않는다 — 임시 파일에 쓰고 바꿔 단다
 *  - 다른 프로그램이 그 사이 고친 파일을 말없이 덮지 않는다 — 수정 시각을 비교한다
 */
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface MdMeta {
  eol: "\r\n" | "\n";
  bom: boolean;
  /** 읽을 때의 인코딩. 저장은 늘 UTF-8 이다. */
  charset: "utf-8" | "euc-kr";
  /** 마지막으로 읽거나 쓴 때의 디스크 수정 시각. 새 문서는 0 */
  mtimeMs: number;
}

export const NEW_META: MdMeta = { eol: "\n", bom: false, charset: "utf-8", mtimeMs: 0 };

/** 편집기는 줄바꿈을 \n 으로 다룬다. 원래 줄바꿈은 meta 에 두고 저장할 때 되돌린다. */
export function decodeMd(bytes: Uint8Array): { text: string; meta: Omit<MdMeta, "mtimeMs"> } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;

  let raw: string;
  let charset: MdMeta["charset"] = "utf-8";
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // UTF-8 이 아니면 사내 PC 에서 가장 흔한 EUC-KR(CP949) 로 읽는다.
    raw = new TextDecoder("euc-kr").decode(body);
    charset = "euc-kr";
  }

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { text: raw.replace(/\r\n/g, "\n"), meta: { eol, bom: bom && charset === "utf-8", charset } };
}

export function encodeMd(text: string, meta: Pick<MdMeta, "eol" | "bom">): Buffer {
  const body = Buffer.from(meta.eol === "\n" ? text : text.replace(/\n/g, meta.eol), "utf8");
  return meta.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

export async function readMd(path: string): Promise<{ text: string; meta: MdMeta; size: number }> {
  const bytes = await readFile(path);
  const { mtimeMs } = await stat(path);
  const { text, meta } = decodeMd(bytes);
  return { text, meta: { ...meta, mtimeMs }, size: bytes.length };
}

export type SaveOutcome =
  | { ok: true; meta: MdMeta; size: number }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; message: string };

/**
 * 저장한다. `force` 가 아니면 디스크의 수정 시각이 읽은 때와 같아야 한다.
 *
 * EUC-KR 로 읽은 파일도 UTF-8 로 쓴다. 화면이 저장 전에 그 사실을 알린다.
 */
export async function saveMd(path: string, text: string, meta: MdMeta, force: boolean): Promise<SaveOutcome> {
  if (!force && meta.mtimeMs !== 0) {
    try {
      if ((await stat(path)).mtimeMs !== meta.mtimeMs) return { ok: false, conflict: true };
    } catch {
      // 파일이 지워졌다. 다시 만드는 것은 덮어쓰기가 아니다.
    }
  }

  const bytes = encodeMd(text, meta);
  // 같은 폴더에 써야 rename 이 다른 드라이브로 넘어가는 복사가 되지 않는다.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    return { ok: false, conflict: false, message: (error as Error).message };
  }

  const { mtimeMs } = await stat(path);
  return { ok: true, meta: { ...meta, charset: "utf-8", mtimeMs }, size: bytes.length };
}
