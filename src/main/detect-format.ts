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

export type DocFormat = "pdf" | "docx" | "xlsx" | "xls" | "pptx" | "unknown";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PDF = Buffer.from("%PDF-", "latin1");

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
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const names = Object.keys(zip.files);
  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  return "unknown";
}

export async function detectFormat(filePath: string): Promise<DocFormat> {
  const magic = await head(filePath, 8);

  if (magic.subarray(0, PDF.length).equals(PDF)) return "pdf";
  if (magic.subarray(0, ZIP.length).equals(ZIP)) return zipKind(filePath);
  // OLE2 복합 문서. HWP 5.x 도 같은 컨테이너지만 지원 대상이 아니므로
  // 확장자로 xls 만 받는다.
  if (magic.equals(OLE2)) return extname(filePath).toLowerCase() === ".xls" ? "xls" : "unknown";

  return "unknown";
}
