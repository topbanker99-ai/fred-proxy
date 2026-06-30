// api/kr.js — 한국은행 ECOS 프록시 (키는 ECOS_API_KEY 환경변수에서만 읽음)
// 브라우저에서 키 노출 없이 ECOS 통계를 받기 위한 서버 패스스루.
//
// 사용 1) 패스스루: /api/kr?path=StatisticSearch/json/kr/1/100/722Y001/M/202401/202612/0101000
//   - path 는 ECOS URL에서 "서비스명 다음(키 자리 제외)" 부분 전체.
//   - 서버가 서비스명 뒤에 키를 끼워넣어 호출함.
// 사용 2) 표 검색: /api/kr?service=StatisticTableList&q=반도체   (q 로 표 이름 필터)
// 사용 3) 항목 목록: /api/kr?service=StatisticItemList&stat=722Y001
//
// fred.js / quote.js / indices.js 와 독립.

const BASE = 'https://ecos.bok.or.kr/api';
// 읽기 전용 서비스만 허용 (키 오남용 방지)
const ALLOWED = ['StatisticSearch', 'StatisticTableList', 'StatisticItemList', 'KeyStatisticList', 'StatisticWord', 'StatisticSearchList'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const key = process.env.ECOS_API_KEY;
    if (!key) {
      const seen = Object.keys(process.env).filter((k) => /ECOS/i.test(k));
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: 'ECOS_API_KEY 미설정', seen }));
    }

    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));

    let service, tail;
    const path = get('path');
    if (path) {
      const parts = String(path).split('/').filter(Boolean);
      service = parts.shift();
      tail = parts.join('/');
    } else {
      service = String(get('service') || 'StatisticSearch');
      const start = get('start') || '1', endRow = get('end_row') || '1000';
      if (service === 'StatisticTableList') tail = `json/kr/${start}/${endRow}`;
      else if (service === 'StatisticItemList') tail = `json/kr/${start}/${endRow}/${get('stat') || ''}`;
      else if (service === 'KeyStatisticList') tail = `json/kr/${start}/${get('end_row') || '100'}`;
      else { // StatisticSearch
        tail = `json/kr/1/${get('end_row') || '200'}/${get('stat') || ''}/${get('cycle') || 'M'}/${get('startd') || ''}/${get('endd') || ''}/${get('item') || ''}`;
      }
    }

    if (ALLOWED.indexOf(service) === -1) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: '허용되지 않은 서비스: ' + service, allowed: ALLOWED }));
    }

    const url = `${BASE}/${service}/${encodeURIComponent(key)}/${tail}`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));

    // q 필터 (표/항목 이름 검색 편의)
    const q = get('q');
    let out = j;
    if (q && j && j[service] && Array.isArray(j[service].row)) {
      const qq = String(q);
      out = { [service]: { row: j[service].row.filter((x) => JSON.stringify(x).indexOf(qq) !== -1) } };
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
