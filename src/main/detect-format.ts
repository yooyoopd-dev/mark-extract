/**
 * 포맷 판별 (docs/design/01-architecture.md).
 *
 * 확장자가 아니라 매직 바이트로 본다. 사용자가 받은 파일의 확장자가 실제 내용과
 * 다른 경우가 드물지 않고, 그때는 내용을 따라야 한다.
 */
import { open } from "node:fs/promises";
import { extname } from "node:path";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";

export type DocFormat = "pdf" | "docx" | "xlsx" | "xls" | "pptx" | "protected" | "unknown";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF = Buffer.from("%PDF-", "latin1");

/** OOXML 은 ZIP 이다. 같은 확장자인데 OLE2 면 껍데기가 한 겹 더 씌워진 것이다. */
const OOXML = new Set([".docx", ".xlsx", ".pptx"]);

// OLE2 디렉터리 엔트리 이름은 UTF-16LE 로 들어 있다. Office 표준 암호화가 쓰는
// 두 스트림 이름이며, 사내 DRM 도 대개 같은 컨테이너를 쓴다. 다른 벤더의 스트림
// 이름은 확인한 것이 없어 넣지 않는다 — 대신 확장자로 한 번 더 받는다.
const MARKERS = ["EncryptedPackage", "EncryptionInfo"].map((name) => Buffer.from(name, "utf16le"));

async function head(filePath: string, length: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** ZIP 컨테이너 안의 엔트리 이름으로 OOXML 종류를 가른다. */
async function zipKind(filePath: string): Promise<DocFormat> {
  // 엔트리를 암호화한 ZIP 이면 여기서 던진다. 영어 예외 원문이 화면에 뜨는 것보다
  // 판별 실패로 다루는 편이 낫다.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(filePath));
  } catch {
    return "unknown";
  }
  const names = Object.keys(zip.files);
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  return "unknown";
}

/**
 * 암호·DRM 으로 감싼 OLE2 인가.
 *
 * build.25 실측: 사내 문서는 DRM 이 기본이라 대부분 여기로 온다. 예전에는
 * "unknown" 으로 뭉뚱그려 "HWP 계열은 지원하지 않습니다" 라고 말했는데, 그것은
 * 틀린 안내였다 — 사용자가 할 일은 DRM 을 푸는 것이다.
 */
async function looksProtected(filePath: string): Promise<boolean> {
  // 디렉터리 엔트리는 파일 앞쪽 섹터에 모여 있다. 전부 읽지 않는다.
  const front = await head(filePath, 64 * 1024);
  return MARKERS.some((marker) => front.includes(marker));
}

export async function detectFormat(filePath: string): Promise<DocFormat> {
  const magic = await head(filePath, 8);

  if (magic.subarray(0, PDF.length).equals(PDF)) return "pdf";
  if (magic.subarray(0, ZIP.length).equals(ZIP)) return zipKind(filePath);

  // OLE2 복합 문서. HWP 5.x 와 옛 .doc·.ppt 도 같은 컨테이너지만 지원 대상이
  // 아니므로 확장자로 xls 만 받는다.
  if (magic.equals(OLE2)) {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".xls") return "xls";
    // 확장자가 OOXML 인데 ZIP 이 아니면 껍데기가 씌워진 것이다. 스트림 이름을
    // 찾지 못해도 이 조합 자체가 근거다.
    if (OOXML.has(ext) || (await looksProtected(filePath))) return "protected";
    return "unknown";
  }

  return "unknown";
}
