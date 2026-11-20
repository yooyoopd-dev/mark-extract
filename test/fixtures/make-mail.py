#!/usr/bin/env python3
"""HTML·EML 시험 자료 (build.34). 파이썬 표준 라이브러리만 쓴다.

    python3 test/fixtures/make-mail.py

만드는 것과 이유:

  sample-euckr.html  <meta charset> 없이 EUC-KR 로 저장한 HTML. 사내 웹 시스템에서
                     저장한 파일이 이렇다. UTF-8 로 읽으면 깨진다
  sample-ko.eml      multipart/alternative(text + html) 안에 multipart/related 로 cid
                     그림 한 장, 그리고 PDF 첨부 하나. 제목은 UTF-8 base64 인코딩,
                     HTML 본문은 quoted-printable. 표·목록·링크가 HTML 파트에만 있다 —
                     text 파트를 고르면 단언이 문다
  sample-text.eml    text/plain 하나뿐. 제목이 ks_c_5601-1987(=EUC-KR) 인코딩이다.
                     Outlook 이 한국어 메일에 붙이는 이름이다

기존 자료는 다시 만들지 않는다 — 이 스크립트는 위 세 파일만 쓴다.
"""
from email.charset import Charset, BASE64, QP
from email.header import Header
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from pathlib import Path

HERE = Path(__file__).parent

# ── sample-euckr.html ──────────────────────────────────
EUCKR_HTML = """<html><head><title>사내 공지</title></head><body>
<h1>사내 공지</h1>
<p>이 문서는 <b>EUC-KR</b> 로 저장했고 문자셋 선언이 없습니다.</p>
<ul><li>첫째 항목</li><li>둘째 항목</li></ul>
</body></html>
"""
(HERE / "sample-euckr.html").write_bytes(EUCKR_HTML.encode("euc-kr"))

# ── sample-ko.eml ──────────────────────────────────────
# 1x1 PNG. 내용은 상관없다 — 본문이 cid 로 가리키는지가 요점이다.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d4944415478da63f8cfc0f01f0005000201a1a3d3e2"
    "0000000049454e44ae426082"
)
# 진짜 PDF 일 필요는 없다. 꺼내지 않으므로 이름과 크기만 본다.
PDF = b"%PDF-1.4\n% fixture attachment\n" + b"0" * 2000

utf8_qp = Charset("utf-8")
utf8_qp.body_encoding = QP

TEXT = "안녕하세요.\n\n이 메일은 시험 자료입니다. (text 파트)\n"
HTML = """<html><body>
<p>안녕하세요.</p>
<p>이 메일은 <b>시험 자료</b>입니다. (html 파트)</p>
<ul><li>회의: 목요일 오후 2시</li><li>장소: 3층 회의실</li></ul>
<table border="1"><tr><th>항목</th><th>담당</th></tr><tr><td>예산</td><td>김철수</td></tr></table>
<p><img src="cid:logo@markextract" alt="로고"></p>
<p>자세한 내용은 <a href="https://intranet.example/notice/1">공지</a>를 보세요.</p>
</body></html>
"""

alt = MIMEMultipart("alternative")
alt.attach(MIMEText(TEXT, "plain", "utf-8"))
html_part = MIMEText("", "html")
html_part.set_payload(HTML, utf8_qp)
alt.attach(html_part)

related = MIMEMultipart("related")
related.attach(alt)
logo = MIMEImage(PNG, "png")
logo.add_header("Content-ID", "<logo@markextract>")
logo.add_header("Content-Disposition", "inline", filename="logo.png")
related.attach(logo)

mail = MIMEMultipart("mixed")
mail["Subject"] = Header("[공지] 3분기 회의 일정", "utf-8")
mail["From"] = formataddr((str(Header("홍길동", "utf-8")), "hong@example.com"))
mail["To"] = formataddr((str(Header("김철수", "utf-8")), "kim@example.com"))
mail["Cc"] = "lee@example.com"
mail["Date"] = "Thu, 19 Nov 2026 14:05:00 +0900"
mail.attach(related)
attachment = MIMEApplication(PDF, "pdf")
attachment.add_header("Content-Disposition", "attachment", filename=("utf-8", "", "회의자료.pdf"))
mail.attach(attachment)
(HERE / "sample-ko.eml").write_bytes(mail.as_bytes())

# ── sample-text.eml ────────────────────────────────────
euckr_b64 = Charset("euc-kr")
euckr_b64.header_encoding = BASE64
euckr_b64.body_encoding = BASE64
plain = MIMEText("", "plain")
plain.set_payload("텍스트로만 된 메일입니다.\n\n둘째 문단.\n", euckr_b64)
# Outlook 은 같은 문자셋을 ks_c_5601-1987 이라 부른다. 이름만 바꿔 단다.
subject = "=?ks_c_5601-1987?B?" + __import__("base64").b64encode("텍스트 메일".encode("euc-kr")).decode() + "?="
plain["Subject"] = subject
plain["From"] = "park@example.com"
plain["To"] = "kim@example.com"
plain["Date"] = "Wed, 18 Nov 2026 09:30:00 +0900"
(HERE / "sample-text.eml").write_bytes(plain.as_bytes())

print("sample-euckr.html sample-ko.eml sample-text.eml")
