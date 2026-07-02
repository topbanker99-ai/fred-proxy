// api/gov.js — 미 재무부 공개데이터 패스스루 프록시(CORS 우회용)
//   TreasuryDirect(경매) + FiscalData(국가부채) — 무료·무인증 공식 API.
//   GET /api/gov?url=<encoded target>  (허용 호스트만)
//   공개 CORS 프록시(allorigins 등) 불안정 대체.

const ALLOW_HOSTS = ['www.treasurydirect.gov', 'treasurydirect.gov', 'api.fiscaldata.treasury.gov'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const target = (req.query && req.query.url != null ? req.query.url : params.get('url')) || '';
    if (!target) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'url 파라미터 필요' })); }

    let u;
    try { u = new URL(target); } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: '잘못된 url' })); }
    if (u.protocol !== 'https:' || ALLOW_HOSTS.indexOf(u.hostname) === -1) {
      res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: '허용되지 않은 호스트', host: u.hostname, allowed: ALLOW_HOSTS }));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 13000);
    let r, text;
    try {
      r = await fetch(u.toString(), { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 topquant' }, signal: ctrl.signal });
      text = await r.text();
    } catch (e) { clearTimeout(timer); res.statusCode = 502; return res.end(JSON.stringify({ ok: false, error: '원본 호출 실패', detail: String(e).slice(0, 120) })); }
    clearTimeout(timer);

    // 원본이 JSON이면 그대로, 아니면 진단
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.statusCode = r.ok ? 200 : r.status;
    return res.end(text);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
