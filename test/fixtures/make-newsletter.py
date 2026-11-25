#!/usr/bin/env python3
"""HTML·EML 정리 시험 자료 (build.39). 파이썬 표준 라이브러리만 쓴다.

    python3 test/fixtures/make-newsletter.py

make-mail.py 와 나눈 이유: 그 스크립트를 다시 돌리면 MIME 경계가 바뀌어 기존 EML 의
바이트가 달라진다. 이 스크립트는 아래 세 파일만 쓴다.

  sample-newsletter.html  메일 소식지 모양. 배치 표가 세 겹, 그 안에 데이터 표 하나.
                          미리보기 숨김 문구(display:none), aria-hidden·visibility·
                          mso-hide 숨김, 추적 1px 그림, Outlook 조건부 주석과 VML
                          단추, o:p, 폭 없는 글자. 바꾸기 전에는 본문이 칸 하나에
                          뭉치고 HTML 코드가 그대로 남았다
  sample-newsletter.eml   위 HTML 을 base64 로 담은 메일 (text 파트 없음)
  sample-webpage.html     웹 페이지 모양. 1행 2칸 배치 표(차례 | 본문)와 4행 3칸의
                          작은 데이터 표(th 없음 — 크기로 판정된다)
"""
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.header import Header
from pathlib import Path

HERE = Path(__file__).parent

NEWSLETTER = """<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8"><title>사내 소식 11월호</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>body{margin:0} .btn{color:#fff}</style></head>
<body style="margin:0">
<div style="display:none;max-height:0;overflow:hidden">숨김 미리보기 문구&zwnj;&nbsp;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0">
    <tr><td><img src="https://news.example/logo.png" width="120" height="40" alt="회사 로고"></td></tr>
    <tr><td style="padding:20px">
      <h1 style="font-size:24px">사내 소식 11월호</h1>
      <p>안녕하세요. <b>이번 달</b> 소식을 전합니다.</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="50%" valign="top"><h2>행사</h2><p>12월 3일 워크숍</p></td>
        <td width="50%" valign="top"><h2>공지</h2><p>시스템 점검 안내</p></td>
      </tr></table>
      <table border="1"><thead><tr><th>항목</th><th>일정</th></tr></thead>
        <tbody><tr><td>점검</td><td>12/5</td></tr><tr><td>배포</td><td>12/8</td></tr></tbody></table>
      <!--[if mso]><v:roundrect href="https://news.example/more" style="height:40px"><center>VML 단추</center></v:roundrect><![endif]-->
      <v:rect style="width:10px">VML 도형 글자</v:rect>
      <!--[if !mso]><!--><a href="https://news.example/more" class="btn">자세히 보기</a><!--<![endif]-->
      <p class="MsoNormal">문의: <a href="mailto:help@news.example">help@news.example</a><o:p></o:p></p>
      <p aria-hidden="true">화면 낭독기 숨김 문구</p>
      <p style="visibility: hidden">보이지 않는 문구</p>
      <p style="mso-hide:all">아웃룩 숨김 문구</p>
    </td></tr>
    <tr><td style="font-size:11px;color:#999">수신 거부 | 서울시 어딘가 <img src="https://news.example/open.gif" width="1" height="1" alt=""></td></tr>
  </table>
</td></tr></table>
</body></html>
"""
(HERE / "sample-newsletter.html").write_text(NEWSLETTER, encoding="utf-8")

mail = MIMEMultipart("alternative")
mail["Subject"] = Header("사내 소식 11월호", "utf-8")
mail["From"] = "news@news.example"
mail["To"] = "kim@example.com"
mail["Date"] = "Tue, 24 Nov 2026 10:00:00 +0900"
mail.attach(MIMEText(NEWSLETTER, "html", "utf-8"))
(HERE / "sample-newsletter.eml").write_bytes(mail.as_bytes())

WEBPAGE = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>업무 안내</title>
<script>var tracking = "스크립트 글자";</script></head><body>
<table width="100%"><tr>
  <td width="200" valign="top"><ul><li><a href="#a">차례 하나</a></li><li><a href="#b">차례 둘</a></li></ul></td>
  <td valign="top">
    <h1>업무 안내</h1>
    <p>본문 첫 문단입니다.</p>
    <table><tr><td>이름</td><td>부서</td><td>내선</td></tr>
      <tr><td>김철수</td><td>총무</td><td>1234</td></tr>
      <tr><td>이영희</td><td>인사</td><td>2345</td></tr>
      <tr><td>박민수</td><td>재무</td><td>3456</td></tr></table>
    <p>본문 끝 문단입니다.</p>
  </td>
</tr></table>
</body></html>
"""
(HERE / "sample-webpage.html").write_text(WEBPAGE, encoding="utf-8")
print("sample-newsletter.html sample-newsletter.eml sample-webpage.html")
