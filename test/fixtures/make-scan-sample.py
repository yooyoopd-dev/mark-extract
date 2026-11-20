#!/usr/bin/env python3
"""글자 레이어가 없는 PDF (build.34).

스캔한 문서는 쪽 전체가 그림 한 장이다. 엔진은 그림 참조만 내고, image-notes.ts 가
그것을 `> [그림 N] …` 줄로 바꾸므로 결과가 **비어 있지 않은 채 글자가 0개**였다 —
그래서 성공으로 나왔다. 그 경로를 재현하는 자료다.

    pip install pillow pypdf
    python3 test/fixtures/make-scan-sample.py

그림 안에 글자 모양을 그려 두지만 PDF 에는 텍스트 객체가 없다. 그것이 요점이다.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).parent

pages = []
for n in (1, 2):
    page = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(page)
    # 글줄처럼 보이는 막대. 텍스트 레이어가 아니라 픽셀이다.
    for row in range(12):
        y = 200 + row * 90
        draw.rectangle((150, y, 1090 - (row % 3) * 120, y + 28), fill=(40, 40, 40))
    draw.text((150, 120), f"SCAN PAGE {n}", fill=(0, 0, 0))
    pages.append(page)

pages[0].save(HERE / "sample-scan.pdf", save_all=True, append_images=pages[1:], resolution=150)
print("sample-scan.pdf")

# build.37: 일부 쪽만 스캔인 PDF. 1쪽은 sample-ko.pdf 의 글자 쪽, 2쪽은 위의 스캔 쪽이다.
# 변환은 성공이어야 하고, 2쪽이 "그림만 있는 쪽" 으로 잡혀야 한다.
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
writer.add_page(PdfReader(HERE / "sample-ko.pdf").pages[0])
writer.add_page(PdfReader(HERE / "sample-scan.pdf").pages[0])
with open(HERE / "sample-mixed.pdf", "wb") as out:
    writer.write(out)
print("sample-mixed.pdf")
