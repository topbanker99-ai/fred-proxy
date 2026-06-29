// /api/fred — FRED API 프록시 (CORS 해결 + 키를 서버에 보관)
// 호출 예: /api/fred?series_id=DGS10&limit=5&sort_order=desc
// 키는 Vercel 환경변수 FRED_API_KEY 에서 읽습니다 (브라우저로 노출 안 됨).

module.exports = async (req, res) => {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const KEY = process.env.FRED_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'FRED_API_KEY not set in Vercel env' }); return; }

  try {
    const q = req.query || {};
    const series_id = q.series_id;
    if (!series_id) { res.status(400).json({ error: 'series_id required' }); return; }

    // 화이트리스트 파라미터만 전달
    const params = new URLSearchParams();
    params.set('series_id', series_id);
    params.set('api_key', KEY);
    params.set('file_type', 'json');
    params.set('sort_order', q.sort_order === 'asc' ? 'asc' : 'desc');
    if (q.limit) params.set('limit', String(parseInt(q.limit, 10) || 10));
    if (q.observation_start) params.set('observation_start', q.observation_start);
    if (q.observation_end) params.set('observation_end', q.observation_end);

    const url = 'https://api.stlouisfed.org/fred/series/observations?' + params.toString();
    const r = await fetch(url);
    const data = await r.json();

    // 5분 캐시 (FRED 데이터는 자주 안 바뀜)
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'fetch failed', detail: String(e) });
  }
};
