// api/krx.js — 공공데이터포털 금융위원회_주식시세정보 프록시 (키는 DATA_GO_KR_KEY 환경변수)
// GET /api/krx?op=getStockPriceInfo&likeSrtnCd=005930&numOfRows=1
//   - 종목 시세·시가총액(mrktTotAmt)·상장주식수 등.
//   - 키는 Decoding/Encoding 어느 쪽이든 대응(%) 포함 여부로 판별.
// fred.js / quote.js / indices.js / kr.js 와 독립.

const BASE = 'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService';
const ALLOWED_OP = ['getStockPriceInfo', 'getStockMarketInfo'];
// 패스스루 허용 파라미터(데이터포털 표준)
const PASS = ['numOfRows', 'pageNo', 'basDt', 'beginBasDt', 'endBasDt', 'likeSrtnCd', 'likeIsinCd', 'likeItmsNm', 'mrktCls', 'isinCd', 'srtnCd', 'itmsNm', 'beginVs', 'endVs'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const raw = process.env.DATA_GO_KR_KEY;
    if (!raw) {
      const seen = Object.keys(process.env).filter((k) => /DATA_GO|GOKR|GO_KR/i.test(k));
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'DATA_GO_KR_KEY 미설정', seen }));
    }

    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));

    const op = String(get('op') || 'getStockPriceInfo');
    if (ALLOWED_OP.indexOf(op) === -1) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: '허용되지 않은 op: ' + op, allowed: ALLOWED_OP }));
    }

    const sp = new URLSearchParams();
    PASS.forEach((k) => { const v = get(k); if (v != null && v !== '') sp.set(k, v); });
    if (!sp.has('numOfRows')) sp.set('numOfRows', '1');
    if (!sp.has('pageNo')) sp.set('pageNo', '1');
    sp.set('resultType', 'json');

    // Decoding 키(원본)면 인코딩, Encoding 키(이미 %포함)면 그대로
    const keyParam = raw.indexOf('%') >= 0 ? raw : encodeURIComponent(raw);
    const url = `${BASE}/${op}?serviceKey=${keyParam}&${sp.toString()}`;

    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); }
    catch (e) {
      // 인증 오류 등은 XML로 오기도 함 → 원문 일부를 진단으로 전달
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: false, error: '비JSON 응답(인증/활용신청 확인 필요)', status: r.status, raw: text.slice(0, 400) }));
    }
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    res.statusCode = 200;
    res.end(JSON.stringify(j));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
