/**
 * 파서 어댑터 검증. 시험 자료를 변환해 단언한다.
 *
 * Electron 없이 돌린다 — 어댑터는 electron 의 app 을 경로 판정에만 쓰므로 가짜로
 * 채워 넣는다. CI 의 Windows 러너에서 한글 변환을 확인하는 것이 이 스크립트의
 * 존재 이유다.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// 어댑터가 electron 의 app.isPackaged 만 본다. 개발 경로로 풀리게 해 둔다.
require.cache[require.resolve("electron")] = { exports: { app: { isPackaged: false } } };

const { convert } = require(join(root, "out/main/convert.js"));
const { probe } = require(join(root, "out/main/parsers/pdf-opendataloader.js"));
const { detectFormat } = require(join(root, "out/main/detect-format.js"));
const { noteImages } = require(join(root, "out/main/image-notes.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  통과  ${name}`);
  else {
    console.log(`  실패  ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const fixture = (name) => join(root, "test/fixtures", name);
const outDir = join(root, "out/verify");
mkdirSync(outDir, { recursive: true });

const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-")));

/* ── 엔진 ─────────────────────────────────────────────── */
console.log("PDF 엔진 확인");
const health = await probe();
check("CLI 가 응답한다 (--export-options)", health.ok, health.detail);

/* ── 포맷 판별 ─────────────────────────────────────────── */
console.log("\n포맷 판별 (매직 바이트)");
for (const [file, want] of [
  ["sample-ko.pdf", "pdf"],
  ["sample-ko.docx", "docx"],
  ["sample-ko.xlsx", "xlsx"],
  ["sample-ko.xls", "xls"],
  ["sample-ko.pptx", "pptx"],
]) {
  const got = await detectFormat(fixture(file));
  check(`${file} → ${want}`, got === want, `실제 ${got}`);
}

// 확장자를 속여도 내용을 따라야 한다. 전용 임시 디렉터리를 써서 다른 사용자가
// 남긴 파일과 부딪히지 않게 한다.
const scratch = mkdtempSync(join(tmpdir(), "markextract-verify-"));
try {
  const misnamed = join(scratch, "실제로는-docx.pdf");
  copyFileSync(fixture("sample-ko.docx"), misnamed);
  check("확장자가 .pdf 여도 내용이 docx 면 docx", (await detectFormat(misnamed)) === "docx");

  // 암호·DRM 으로 감싼 문서 (build.25 실측). OLE2 컨테이너 안에 문서가 들어 있는
  // 모양이라 예전에는 전부 "unknown" 으로 떨어져 "HWP 계열은 지원하지 않습니다"
  // 라는 엉뚱한 문구를 보여 주었다.
  const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const encrypted = join(scratch, "보호된 문서.docx");
  writeFileSync(
    encrypted,
    Buffer.concat([OLE2, Buffer.alloc(512), Buffer.from("EncryptedPackage", "utf16le")]),
  );
  check("OLE2 + EncryptedPackage → protected", (await detectFormat(encrypted)) === "protected");

  // 스트림 이름을 못 찾아도 확장자 조합만으로 판정한다. OOXML 은 ZIP 이어야 하므로
  // .docx 인데 OLE2 면 껍데기가 한 겹 더 있다는 뜻이다.
  const wrapped = join(scratch, "확장자만 docx.docx");
  writeFileSync(wrapped, Buffer.concat([OLE2, Buffer.alloc(2048)]));
  check("OLE2 + .docx 확장자 → protected", (await detectFormat(wrapped)) === "protected");

  const result = await convert({ filePath: encrypted });
  check("보호된 문서는 DRM_PROTECTED 로 실패한다", result.error?.code === "DRM_PROTECTED", result.error?.code);
  check(
    "안내가 DRM 해제를 말한다",
    (result.error?.message ?? "").includes("DRM 을 해제한 사본"),
    result.error?.message,
  );
  check("HWP 얘기를 하지 않는다", !(result.error?.message ?? "").includes("HWP"), result.error?.message);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/* ── 그림 위치 표시 (합성 입력) ───────────────────────── */
//
// 실제 문서로는 닿지 않는 가지들이다. 시험 자료를 매번 새로 만드는 것보다
// 함수에 직접 넣어 보는 쪽이 값싸고 정확하다.
console.log("\n그림 위치 표시 — 합성 입력");
{
  const withPages = [
    "<!-- markextract-page 1 -->",
    "## 첫째 절",
    "![](<a_images/imageFile1.png>)",
    "<!-- markextract-page 2 -->",
    "본문",
    "![image](b.png)",
  ].join("\n");

  const noted = noteImages(withPages, "note");
  check("쪽 구분자를 본문에서 지운다", !noted.markdown.includes("markextract-page"));
  check("쪽이 바뀌면 쪽 번호도 바뀐다", /\[그림 2\] 2쪽/.test(noted.markdown), noted.markdown);
  check("쪽이 넘어가도 제목은 유효하다", noted.markdown.includes('[그림 2] 2쪽 · "첫째 절" 아래'));
  check("인용 줄로 나온다", noted.markdown.split("\n").some((l) => l.startsWith("> [그림 1]")));

  const off = noteImages(withPages, "off");
  check("off 는 참조를 남기지 않는다", !off.markdown.includes("!["), off.markdown);
  check("off 는 위치 표시도 하지 않는다", !off.markdown.includes("[그림"), off.markdown);
  check("off 는 경고를 내지 않는다", off.warnings.length === 0);
  check("off 가 본문을 지우지는 않는다", off.markdown.includes("본문"));

  // 위치를 하나도 모르는 입력. 쪽도 제목도 없다.
  const bare = noteImages("![](x.png)", "note");
  check("위치를 모르면 번호만 남긴다", bare.markdown.trim() === "> [그림 1] 내용을 글자로 옮기지 못했습니다.", bare.markdown);

  // 표 셀처럼 다른 내용과 섞인 줄. 인용 줄을 넣으면 표가 깨진다.
  const cell = noteImages("| 표 안 | ![](y.png) |", "note");
  check("섞인 줄은 인라인으로", cell.markdown === "| 표 안 | [그림 1] |", cell.markdown);

  // 그림이 없으면 아무것도 하지 않는다.
  const none = noteImages("# 제목\n\n본문", "note");
  check("그림이 없으면 경고도 없다", none.warnings.length === 0 && none.markdown === "# 제목\n\n본문");
}

/* ── 변환 ─────────────────────────────────────────────── */
const COMMON = [
  ["제목", (md) => md.includes("문서 변환 시험 자료")],
  ["표 내용", (md) => md.includes("opendataloader-pdf") && md.includes("markitdown 규칙")],
  ["숫자·기호", (md) => md.includes("1,234,567원") && md.includes("45.6%")],
  // 시험 자료마다 곧은 따옴표와 굽은 따옴표가 섞여 있다. 어느 쪽이든 글자가
  // 온전히 넘어왔는지를 본다 — 깨지면 물음표나 사각형이 된다.
  ["따옴표 보존", (md) => /[\u201c"]인용[\u201d"]/.test(md)],
];

/**
 * 병합 표·셀 안 줄바꿈·특수문자 — build.8 Windows 실측에서 보고된 결함을 겨냥한다.
 *
 * 두 엔진이 같은 결과를 내야 한다. kordoc 은 병합이 있으면 <table> 로 떨어지고,
 * opendataloader 는 --markdown-with-html 로 받으므로 역시 <table> 이다. 둘 다
 * html-in-markdown.ts 가 파이프 표로 바꾼다.
 */
const TABLE_CHECKS = [
  ["HTML 표가 남아 있지 않다", (md) => !/<table[\s>]/i.test(md)],
  ["HTML 엔티티가 남아 있지 않다", (md) => !/&(amp|lt|gt|quot|#\d+);/.test(md)],
  ["병합 헤더가 걸친 칸마다 반복된다", (md) => /\|\s*2026년 추진 계획\s*\|\s*2026년 추진 계획\s*\|\s*2026년 추진 계획\s*\|/.test(md)],
  ["세로 병합 값이 두 행에 모두 있다", (md) => (md.match(/\|\s*1분기\s*\|/g) ?? []).length >= 2],
  ["셀 안 줄바꿈이 <br> 로 남는다", (md) => md.includes("첫째 줄<br>둘째 줄<br>셋째 줄")],
  ["셀 안 파이프가 이스케이프된다", (md) => md.includes("파이프 \\| 와")],
  ["꺾쇠가 원래 글자로 돌아온다", (md) => md.includes("<태그>")],
  // 표 밖 엔티티는 xmldom 을 거치지 않아 decodeEntities 만이 푼다.
  ["표 밖 엔티티도 풀린다", (md) => md.includes("부등호 5 < 10")],
  ["앰퍼샌드가 원래 글자로 돌아온다", (md) => md.includes("앰퍼샌드 & 를")],
  ["표 밖에는 <br> 이 없다", (md) => !/<br\s*\/?>/i.test(md.split("\n").filter((l) => !l.trimStart().startsWith("|")).join("\n"))],
  ["병합을 폈다는 경고가 붙는다", (md, result) => result.warnings.some((w) => w.code === "TABLE_MERGE_FLATTENED")],
  // build.25 실측. kordoc 의 escapeGfm 이 * _ ~ ` 를 전부 이스케이프해서 원문에 없던
  // 역슬래시가 사용자에게 보였다. 두 엔진에 같은 자료를 넣어 함께 본다 —
  // opendataloader 는 애초에 이스케이프하지 않는다(실측).
  ["별표로 시작한 줄에 역슬래시가 없다", (md) => md.includes("\n* 별표로 시작하는 줄")],
  ["밑줄·물결·백틱도 원래 글자다", (md) => md.includes("밑줄 _강조_ 와 물결 ~취소~ 와 백틱 `코드`")],
  // 표의 파이프는 우리가 일부러 넣는 것이라 남아 있어야 한다 (위 검사와 한 쌍).
  ["역슬래시를 떼도 표는 그대로다", (md) => md.includes("파이프 \\| 와")],
];

/**
 * 못 읽은 그림의 위치 표시 (build.29 실측 → build.30).
 *
 * 네 어댑터가 모두 그림을 파일 참조로 내놓는데 그 파일은 임시 디렉터리와 함께
 * 지워진다. 즉 **어디도 가리키지 않는 링크**가 사용자에게 갔다. 그때까지 시험
 * 자료 어디에도 그림이 한 장도 없어 단언이 전부 통과했다.
 */
const IMAGE_CHECKS = [
  ["이미지 구문이 살아남지 않는다", (md) => !md.includes("![")],
  ["첫 그림에 번호가 붙는다", (md) => md.includes("[그림 1]")],
  ["둘째 그림에도 번호가 붙는다", (md) => md.includes("[그림 2]")],
  ["못 읽었다고 말한다", (md) => md.includes("내용을 글자로 옮기지 못했습니다")],
  ["경고가 한 건으로 묶인다", (md, r) => r.warnings.filter((w) => w.code === "IMAGE_NOT_EXTRACTED").length === 1],
  [
    "경고가 개수와 다음 수단을 말한다",
    (md, r) => {
      const w = r.warnings.find((x) => x.code === "IMAGE_NOT_EXTRACTED");
      return /그림 \d+개/.test(w?.message ?? "") && (w?.message ?? "").includes("OCR");
    },
  ],
];

const CASES = [
  {
    file: "sample-ko.pdf",
    engine: "opendataloader",
    extra: [
      ["H2·H3 제목 계층", (md) => md.includes("## 1. 제목 계층") && md.includes("### 1.1 하위 절")],
      ["표 헤더", (md) => /\|\s*형식\s*\|/.test(md)],
      ["한글 줄 잇기: '섞여 있으며' 가 붙어 있다", (md) => md.includes("섞여 있으며")],
      ["한글 줄 잇기: '섞여 있 으며' 가 없다", (md) => !md.includes("섞여 있 으며")],
      ["영문 줄 잇기: 'and markdown.' 에 공백", (md) => md.includes("and markdown.")],
    ],
  },
  {
    file: "sample-ko.docx",
    engine: "kordoc",
    extra: [
      ["H2·H3 제목 계층", (md) => md.includes("## 1. 제목 계층") && md.includes("### 1.1 하위 절")],
      ["표 헤더", (md) => /\|\s*형식\s*\|/.test(md)],
    ],
  },
  {
    file: "sample-ko.xlsx",
    engine: "kordoc",
    extra: [
      ["시트가 제목이 된다", (md) => md.includes("## 변환 대상") && md.includes("## 두 번째 시트")],
      // 스프레드시트에 PDF 용 줄 잇기를 적용하면 별개 셀이 뭉개진다.
      ["별개 셀이 합쳐지지 않았다", (md) => !md.includes("본다. English and")],
    ],
  },
  {
    file: "sample-ko.xls",
    engine: "kordoc",
    extra: [["시트가 제목이 된다", (md) => md.includes("## 변환 대상")]],
  },
  {
    file: "sample-ko.pptx",
    engine: "자체 구현",
    extra: [
      ["슬라이드 경계", (md) => /<!-- Slide number: 1 -->/.test(md) && /<!-- Slide number: 3 -->/.test(md)],
      ["제목이 내용보다 먼저", (md) => md.indexOf("# 2. 표") < md.indexOf("| 형식 |")],
      ["발표자 노트", (md) => md.includes("### Notes:") && md.includes("발표자 노트다")],
      ["표", (md) => /\|\s*형식\s*\|/.test(md)],
    ],
  },  {
    file: "sample-table.docx",
    engine: "kordoc",
    title: "병합 표 시험 자료",
    extra: TABLE_CHECKS,
  },
  {
    file: "sample-table.pdf",
    engine: "opendataloader",
    title: "병합 표 시험 자료",
    extra: TABLE_CHECKS,
  },
  {
    file: "sample-image.pdf",
    engine: "opendataloader",
    title: "그림이 든 시험 자료",
    extra: [
      ...IMAGE_CHECKS,
      // 쪽이 실제로 갈렸는지. 한 쪽짜리 자료였다면 늘 1쪽이라 맞는지 틀리는지
      // 구별되지 않는다 — 그래서 시험 자료를 두 쪽으로 만들었다.
      ["첫 그림이 1쪽", (md) => /\[그림 1\] 1쪽/.test(md)],
      ["마지막 그림이 2쪽", (md) => /\[그림 3\] 2쪽/.test(md)],
      ["직전 제목이 위치에 붙는다", (md) => md.includes('"1. 첫째 쪽 그림" 아래')],
      // 표 셀 안에는 인용 줄을 넣을 수 없어 인라인으로 바꾼다.
      ["표 셀 안은 인라인 [그림 N]", (md) => /\|\s*표 안\s*\|\s*\[그림 2\]\s*\|/.test(md)],
      ["쪽 구분자가 새지 않는다", (md) => !/markextract-page/.test(md)],
      ["그림 뒤 문단이 삼켜지지 않았다", (md) => md.includes("위치 표시 줄이 이 문단을 삼키지 않아야 한다")],
    ],
  },
  {
    file: "sample-image.docx",
    engine: "kordoc",
    title: "그림이 든 시험 자료",
    extra: [
      ...IMAGE_CHECKS,
      // DOCX 에는 쪽 개념이 없다. 가장 가까운 앞선 제목이 위치가 된다.
      ["직전 제목이 위치가 된다", (md) => md.includes('[그림 1] "1. 첫째 그림" 아래')],
      ["쪽 번호를 지어내지 않는다", (md) => !/\[그림 \d+\] \d+쪽/.test(md)],
    ],
  },
  {
    file: "sample-image.pptx",
    engine: "자체 구현",
    title: "1. 첫째 슬라이드",
    extra: [
      ...IMAGE_CHECKS,
      ["슬라이드 번호가 위치가 된다", (md) => md.includes("[그림 1] 1번째 슬라이드")],
      // 슬라이드는 닫힌 칸이라 앞 슬라이드의 제목이 넘어오면 거짓이 된다.
      ["제목 없는 슬라이드에 앞 제목이 새지 않는다", (md) => md.includes("[그림 2] 2번째 슬라이드 —")],
    ],
  },
];

for (const { file, engine, extra , title } of CASES) {
  console.log(`\n${file}`);
  const result = await convert({ filePath: fixture(file) });

  check("변환 성공", result.ok, result.error?.message);
  if (!result.ok) {
    for (const entry of result.log) console.log(`        ${entry.label}: ${entry.value}`);
    continue;
  }

  const md = result.markdown;
  check(`엔진: ${engine}`, result.meta.engine.includes(engine), result.meta.engine);

  // title 이 있는 자료는 내용이 달라 COMMON 을 적용하지 않는다 (표 시험 자료).
  const common = title === undefined ? COMMON : [["제목", (m) => m.includes(title)]];
  for (const [name, test] of [...common, ...extra]) check(name, test(md, result));

  writeFileSync(join(outDir, file.replace(/\.[^.]+$/, "") + `.${file.split(".").pop()}.md`), md);
}

/* ── 뒷정리 ───────────────────────────────────────────── */
const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("markextract-") && !before.has(n));
console.log("\n뒷정리");
check("임시 디렉터리가 남지 않았다", leaked.length === 0, leaked.join(", "));

console.log(`\n결과 저장: out/verify/`);
if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\n파서 검증 통과");
