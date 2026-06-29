# FRED 프록시 (Vercel)

## 이 폴더 구성
- api/fred.js   ← FRED 프록시 함수 (이게 핵심)
- package.json
- vercel.json
- README.md

## 배포 후 환경변수 (필수)
Vercel 프로젝트 → Settings → Environment Variables
- Key:   FRED_API_KEY
- Value: (본인 FRED 키 32자리)

## 테스트
배포 후 브라우저에서:
https://<your-project>.vercel.app/api/fred?series_id=DGS10&limit=1
→ JSON 데이터가 나오면 성공
