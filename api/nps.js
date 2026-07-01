// api/nps.js — 국민연금 기금 포트폴리오 현황(공공데이터포털 fileData 자동변환 OpenAPI, odcloud)
//   국내주식 목표비중(20.8%) 대비 실제 비중 → 리밸런싱 매도 압력 신호용.
//   키는 DATA_GO_KR_KEY(주식시세·대차와 동일 계정 키) 재사용.
//   GET /api/nps?uddi=<uddi>&page=1&perPage=100
//     - uddi: 활용신청 후 마이페이지에 표시되는 uddi:xxxxxxxx-... 값(접두 'uddi:' 유무 무관)
//     - dataset id는 15106894(기금 포트폴리오 현황)로 고정
//   fred/quote/indices/kr/krx/slb 와 독립.

const DATASET = '15106894';
const ODBASE = 'https://api.odcloud.kr/api';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const raw = process.env.DATA_GO_KR_KEY;
    if (!raw) { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: 'DATA_GO_KR_KEY 미설정' })); }

    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));

    let uddi = String(get('uddi') || '').trim();
    if (!uddi) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'uddi 파라미터 필요(활용신청 후 마이페이지 요청주소의 uddi:... 값)' })); }
    if (uddi.indexOf('uddi:') !== 0) uddi = 'uddi:' + uddi;

    const page = get('page') || '1';
    const perPage = get('perPage') || '200';

    // odcloud는 인코딩/원본 키 모두 허용될 수 있어 두 후보 시도
    let decoded = raw;
    try { if (raw.indexOf('%') >= 0) decoded = decodeURIComponent(raw); } catch (e) {}
    const candidates = [encodeURIComponent(decoded), raw];

    let last = null;
    for (const keyParam of candidates) {
      const url = `${ODBASE}/${DATASET}/v1/${encodeURIComponent(uddi)}?serviceKey=${keyParam}&page=${page}&perPage=${perPage}&returnType=JSON`;
      let status = 0, text = '';
      try {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
        clearTimeout(timer); status = r.status; text = await r.text();
      } catch (e) { last = { status: 0, text: String(e).slice(0, 160) }; continue; }
      let j = null; try { j = JSON.parse(text); } catch (e) {}
      // 정상 응답(data 배열 존재)이면 그대로 반환
      if (j && (Array.isArray(j.data) || j.currentCount != null)) {
        res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
        res.statusCode = 200;
        return res.end(JSON.stringify({ ok: true, uddi, page: Number(page), perPage: Number(perPage), data: j.data || [], totalCount: j.totalCount, currentCount: j.currentCount }));
      }
      last = { status, text: (text || '').slice(0, 200) };
      // 키 미등록이면 다음 후보; 그 외 오류면 중단
      if (!/등록되지|NOT.?REGISTERED|SERVICE.?KEY/i.test(text)) break;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: '기금 포트폴리오 호출 실패(키 미등록/전파 지연 또는 uddi 확인 필요)', detail: last }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
