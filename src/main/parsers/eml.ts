/**
 * EML → Markdown (docs/design/02-parser-adapters.md#eml--postal-mime).
 *
 * MIME 은 postal-mime 이 푼다 — 인코딩된 제목(`=?UTF-8?B?…?=`, `=?ks_c_5601-1987?…`),
 * quoted-printable·base64 본문, 여러 겹의 multipart 까지.
 *
 * 내는 것은 머리(제목·보낸 사람·받는 사람·참조·날짜) + 본문 + 첨부 목록이다.
 * 본문은 HTML 파트를 먼저 쓴다 — 표·목록·강조가 거기에만 있다. 없으면 text/plain 을
 * 그대로 둔다.
 *
 * **첨부는 꺼내지도 변환하지도 않는다** (사용자 결정). 이름과 크기만 적는다. 본문에
 * 박힌 cid 그림은 목록에서 뺀다 — 본문의 `[그림 N]` 이 그 자리를 가리킨다.
 */
import { readFile } from "node:fs/promises";
import PostalMime from "postal-mime";
import { htmlToMarkdown } from "./html";
import { normalizeMarkdown } from "../normalize";
import type { LogEntry, ParseRequest, ParseResult, Warning } from "../../shared/parse";

const ENGINE = "로컬 · postal-mime";

type Address = PostalMime.Address;
type Attachment = PostalMime.Attachment;

const mailbox = (a: { name: string; address?: string | undefined }): string =>
  a.name !== "" && a.address ? `${a.name} <${a.address}>` : a.address || a.name;

/** 그룹 주소(`팀: a@x, b@y;`)는 그룹 이름 뒤에 구성원을 적는다. */
function addresses(list: readonly Address[] | undefined): string {
  return (list ?? [])
    .map((a) => (a.group ? `${a.name}: ${a.group.map(mailbox).join(", ")}` : mailbox(a)))
    .filter((s) => s !== "")
    .join(", ");
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const byteLength = (content: Attachment["content"]): number =>
  typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;

/** 본문에 박혀 있던 그림인가. 본문 HTML 이 `cid:` 로 가리키는 것만 그렇게 본다. */
const embedded = (a: Attachment, html: string): boolean =>
  a.contentId !== undefined && html.includes(`cid:${a.contentId.replace(/^<|>$/g, "")}`);

/** 머리 줄. 받는 사람이 없는 초안 메일도 있으므로 값이 있는 것만 적는다. */
function header(mail: PostalMime.Email): string {
  // 날짜는 원문 Date 머리를 그대로 쓴다. postal-mime 은 ISO 로 바꿔 주지만 시간대가
  // UTC 로 옮겨져 원문의 +0900 이 사라진다.
  const date = mail.headers.find((h) => h.key === "date")?.value ?? mail.date ?? "";
  const rows: Array<[string, string]> = [
    ["보낸 사람", addresses(mail.from ? [mail.from] : undefined)],
    ["받는 사람", addresses(mail.to)],
    ["참조", addresses(mail.cc)],
    ["날짜", date.trim()],
  ];
  const subject = mail.subject?.trim() || "(제목 없음)";
  return [`# ${subject}`, "", ...rows.filter(([, v]) => v !== "").map(([k, v]) => `- ${k}: ${v}`)].join("\n");
}

export async function parseEml(request: ParseRequest): Promise<ParseResult> {
  const started = Date.now();
  const log: LogEntry[] = [{ label: "엔진", value: ENGINE }];

  try {
    const mail = await PostalMime.parse(await readFile(request.filePath));
    const html = mail.html ?? "";
    const warnings: Warning[] = [];

    let body = "";
    if (html.trim() !== "") {
      const converted = htmlToMarkdown(html, request.options?.imageOutput ?? "note");
      body = converted.markdown;
      warnings.push(...converted.warnings);
      log.push({ label: "본문", value: "HTML 파트" });
    } else {
      body = (mail.text ?? "").replace(/\r\n/g, "\n").trim();
      log.push({ label: "본문", value: mail.text === undefined ? "없음" : "text/plain 파트" });
    }

    const listed = mail.attachments.filter((a) => !embedded(a, html));
    const files = listed.map((a) => `- ${a.filename ?? "(이름 없음)"} (${size(byteLength(a.content))})`);
    log.push({ label: "첨부", value: `${listed.length}개 (본문 그림 ${mail.attachments.length - listed.length}개 제외)` });
    if (listed.length > 0) {
      warnings.push({
        code: "ATTACHMENT_NOT_CONVERTED",
        message: `첨부 ${listed.length}개는 변환하지 않았습니다. 이름과 크기만 결과 끝에 적었습니다.`,
      });
    }

    const parts = [header(mail), "---", body === "" ? "(본문 없음)" : body];
    if (files.length > 0) parts.push(["## 첨부 파일", "", ...files].join("\n"));
    const markdown = normalizeMarkdown(parts.join("\n\n"));

    const elapsedMs = Date.now() - started;
    log.push({ label: "소요", value: `${(elapsedMs / 1000).toFixed(1)}초` });
    return { ok: true, markdown, warnings, log, meta: { engine: ENGINE, elapsedMs } };
  } catch (error) {
    return {
      ok: false,
      markdown: "",
      warnings: [],
      log: [...log, { label: "오류", value: error instanceof Error ? error.message : String(error) }],
      meta: { engine: ENGINE, elapsedMs: Date.now() - started },
      error: {
        code: "RUN_FAILED",
        message: error instanceof Error ? error.message : String(error),
        actions: ["retry-plain"],
      },
    };
  }
}
