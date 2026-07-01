// api/slb.js — 한국예탁결제원(SEIBRO) 증권대차서비스(SlbSvc) 프록시
//   대차거래 = 공매도 대기물량 지표. 키는 DATA_GO_KR_KEY(주식시세와 동일 계정 키) 재사용.
//   GET /api/slb?op=getSlbDealingByIsin&isin=KR7005930003&numOfRows=100&...
//   - op 외 모든 쿼리 파라미터는 그대로 SEIBRO로 전달(패스스루)
//   - 응답은 XML → 브라우저에서 DOMParser로 파싱 (raw XML 반환)
//   - fred.js / quote.js / indices.js / kr.js / krx.js 와 독립.

const BASE = 'https://api.seibro.or.kr/openapi/service/SlbSvc';
const ALLOWED_OP = [
  'getSlbDealingByIsin',   // 종목별 대차거래(체결·상환·잔고)
  'getSlbBySctnList',      // (예비) 종목별 대차거래 목록
  'getSlbStatByIsin',      // (예비) 종목별 대차 통계
];
// SEIBRO SlbSvc가 받는 표준 파라미터(널리 쓰이는 후보) — 값이 있으면 그대로 전달
const PASS = ['numOfRows', 'pageNo', 'isin', 'inputDataType', 'pdStrtDd', 'pdEndDd', 'basDd', 'stdDt', 'startDate', 'endDate', 'caltotMartTpcd', 'menuNo'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    const raw = process.env.DATA_GO_KR_KEY;
    if (!raw) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'DATA_GO_KR_KEY 미설정' }));
    }

    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));

    const op = String(get('op') || 'getSlbDealingByIsin');
    if (ALLOWED_OP.indexOf(op) === -1) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: '허용되지 않은 op: ' + op, allowed: ALLOWED_OP }));
    }

    const sp = new URLSearchParams();
    PASS.forEach((k) => { const v = get(k); if (v != null && v !== '') sp.set(k, v); });
    if (!sp.has('numOfRows')) sp.set('numOfRows', '100');
    if (!sp.has('pageNo')) sp.set('pageNo', '1');

    // 키 형태(Decoding/Encoding) 두 후보 순차 시도
    let decoded = raw;
    try { if (raw.indexOf('%') >= 0) decoded = decodeURIComponent(raw); } catch (e) {}
    const candidates = [encodeURIComponent(decoded), raw];

    let lastText = '', lastStatus = 0;
    for (const keyParam of candidates) {
      const url = `${BASE}/${op}?serviceKey=${keyParam}&${sp.toString()}`;
      let status = 0, text = '';
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(url, { headers: { accept: 'application/xml' }, signal: ctrl.signal });
        clearTimeout(timer);
        status = r.status; text = await r.text();
      } catch (e) { lastText = String(e).slice(0, 160); lastStatus = 0; continue; }
      lastText = text; lastStatus = status;
      // 키 미등록이면 다음 후보 시도; 정상/파라미터오류면 그대로 반환
      if (/NOT.?REGISTERED|SERVICE.?KEY|등록되지/i.test(text)) continue;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.statusCode = 200;
      return res.end(text);
    }
    // 모든 후보가 키 미등록 → 진단 반환(키 노출 없음)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: '증권대차 호출 실패(키 미등록/전파 지연 가능)', status: lastStatus, body: (lastText || '').slice(0, 200) }));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
