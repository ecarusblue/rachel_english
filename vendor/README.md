# 외부 라이브러리 (PDF 공유용, 평가서 미리보기의 "공유" 버튼)

| 파일 | 라이브러리 | 버전 | 라이선스 |
|---|---|---|---|
| `html2canvas.min.js` | [html2canvas](https://github.com/niklasvh/html2canvas) | 1.4.1 | MIT |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 4.2.1 | MIT |

공유 버튼을 처음 쓸 때만 불러옵니다(앱 첫 화면 속도에는 영향 없음). 외부 CDN 대신 같은 사이트에서 제공해서 CSP(`script-src 'self'`)를 그대로 유지합니다.

| `exceljs.min.js` | [ExcelJS](https://github.com/exceljs/exceljs) | 4.4.0 | MIT |

수업 기록 탭의 "양식 다운로드" / "엑셀 업로드"를 처음 쓸 때만 불러옵니다.
