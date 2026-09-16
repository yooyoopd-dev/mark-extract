# 시험 자료

`sample-ko.pdf` 는 PDF 어댑터 검증(`npm run verify:pdf`)에 쓴다. 한글·영문 혼재,
H1~H3 제목 계층, 3×3 표, 목록, 숫자·특수문자를 담았다.

PDF 를 커밋해 둔 이유는 CI 가 플랫폼마다 PDF 생성기를 갖출 수 없기 때문이다.
대신 원본 HTML 과 생성 명령을 함께 둬 재현할 수 있게 했다.

```
chrome --headless --disable-gpu --no-pdf-header-footer \
       --print-to-pdf=sample-ko.pdf file://$PWD/sample-ko.html
```

한글 글꼴(Noto Sans CJK KR 등)이 설치된 환경에서 돌려야 한다. 글꼴이 없으면
글자가 빈 사각형으로 들어가 검증이 무의미해진다.
