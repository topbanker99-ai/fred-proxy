// api/indices.js — 글로벌 주가지수 프록시 (Yahoo Finance passthrough · CORS 우회)
// GET /api/indices?symbols=^GSPC,^IXIC,^GDAXI&range=4mo
//   - 브라우저에서 직접 Yahoo를 부르면 CORS에 막혀서, 서버(Vercel)가 대신 받아 전달.
//   - 반환: { ok, data: { "^GSPC": [{t:'YYYY-MM-DD', c:종가}, ...(오래된→최신)], ... }, ts }
// 키 불필요. fred.js / quote.js 와 독립.

const YF = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 2, baseDelay = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(baseDelay * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// 동시 호출 제한 — Yahoo 레이트리밋 회피
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function fetchOne(sym, range) {
  const url = `${YF}${encodeURIComponent(sym)}?range=${encodeURIComponent(range)}&interval=1d`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) {
    const msg = (j && j.chart && j.chart.error && j.chart.error.description) || ('HTTP ' + r.status);
    throw new Error('지수 조회 실패: ' + msg);
  }
  const ts = res.timestamp;
  const close = res.indicators.quote[0].close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null) continue;
    out.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), c });
  }
  if (!out.length) throw new Error('빈 시계열');
  return out;
}

module.exports = async (req, res) => {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));
    const raw = get('symbols') || '';
    const range = String(get('range') || '4mo');
    const symbols = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30); // 과도한 요청 방지

    if (!symbols.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'symbols 파라미터가 필요합니다 (예: ?symbols=^GSPC,^IXIC)' }));
    }

    // 동시 5개 제한 + 실패 재시도 — 한 지수 실패해도 나머지는 반환
    const settled = await mapLimit(symbols, 5, async (sym) => {
      try {
        return [sym, await withRetry(() => fetchOne(sym, range))];
      } catch (e) {
        return [sym, { error: (e && e.message) || String(e) }];
      }
    });

    const data = {};
    settled.forEach(([sym, v]) => {
      data[sym] = v;
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, data, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
