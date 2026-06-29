// api/quote.js — 한국투자증권(KIS) 시세 프록시
// GET /api/quote?symbols=005930,000660,AAPL,NVDA
//   - 6자리 숫자 = 국내주식, 영문 티커 = 해외주식 (자동 구분)
// 키는 환경변수에서만 읽음: process.env.KIS_APPKEY / KIS_APPSECRET (Vercel 프로젝트 설정)

const KIS_BASE = 'https://openapi.koreainvestment.com:9443';

// ── 접근토큰 모듈 스코프 캐시 (발급 1분 제한 회피 · 만료 86400초) ──
let _token = null; // { value, expiresAt }

async function getToken() {
  const now = Date.now();
  // 만료 60초 전까지는 캐시 재사용
  if (_token && _token.expiresAt > now + 60_000) return _token.value;

  const appkey = process.env.KIS_APPKEY;
  const appsecret = process.env.KIS_APPSECRET;
  if (!appkey || !appsecret) {
    // 진단(값 노출 없음): 런타임에 보이는 KIS 관련 변수 이름만 표기
    const seen = Object.keys(process.env).filter((k) => /KIS/i.test(k));
    throw new Error(
      'KIS_APPKEY/KIS_APPSECRET 미설정 — ' +
        'KIS_APPKEY=' + (appkey ? 'OK' : 'X') + ', KIS_APPSECRET=' + (appsecret ? 'OK' : 'X') +
        ', 보이는 KIS 변수: [' + (seen.length ? seen.join(', ') : '없음') + ']'
    );
  }

  const r = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    throw new Error('토큰 발급 실패: ' + (j.error_description || j.msg1 || ('HTTP ' + r.status)));
  }
  const ttlSec = parseInt(j.expires_in, 10) || 86400;
  _token = { value: j.access_token, expiresAt: now + ttlSec * 1000 };
  return _token.value;
}

// 6자리 숫자면 국내
function isDomestic(sym) {
  return /^\d{6}$/.test(sym);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 일시적 실패(레이트리밋 등) 대비 지수 백오프 재시도
async function withRetry(fn, { retries = 2, baseDelay = 350 } = {}) {
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

// 동시 실행 개수 제한 — KIS는 초당 호출 제한이 있어 과도한 병렬 호출 시 일부 종목이 누락됨
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

// 국내 종목 한글명 폴백 — KIS inquire-price의 hts_kor_isnm가 비어 오는 경우가 있어
// 자주 쓰는 종목은 코드→한글명을 직접 매핑한다(있으면 API값 우선, 없으면 이 표, 그래도 없으면 코드).
const KR_NAME = {
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '035420': 'NAVER',
  '035720': '카카오',
  '005380': '현대차',
  '000270': '기아',
  '005490': 'POSCO홀딩스',
  '051910': 'LG화학',
  '006400': '삼성SDI',
  '207940': '삼성바이오로직스',
  '068270': '셀트리온',
  '012330': '현대모비스',
  '028260': '삼성물산',
  '105560': 'KB금융',
  '055550': '신한지주',
  '086790': '하나금융지주',
  '003550': 'LG',
  '015760': '한국전력',
  '034730': 'SK',
  '066570': 'LG전자',
};

// ── 국내 현재가 ──
async function quoteDomestic(sym, token, appkey, appsecret) {
  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', sym);

  const r = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey,
      appsecret,
      tr_id: 'FHKST01010100',
      custtype: 'P',
    },
  });
  const j = await r.json().catch(() => ({}));
  const o = j.output;
  if (j.rt_cd !== '0' || !o) throw new Error('국내 조회 실패: ' + (j.msg1 || ('rt_cd ' + j.rt_cd)));

  return {
    symbol: sym,
    name: o.hts_kor_isnm || KR_NAME[sym] || sym,
    price: parseFloat(o.stck_prpr),
    change: parseFloat(o.prdy_vrss),
    changePct: parseFloat(o.prdy_ctrt),
    currency: 'KRW',
    market: 'KR',
  };
}

// ── 해외 현재가 (NAS→NYS→AMS 순으로 거래소 탐색) ──
const OVERSEAS_EXCD = ['NAS', 'NYS', 'AMS'];

async function quoteOverseas(sym, token, appkey, appsecret) {
  let lastErr = '';
  for (const excd of OVERSEAS_EXCD) {
    try {
      const url = new URL(`${KIS_BASE}/uapi/overseas-price/v1/quotations/price`);
      url.searchParams.set('AUTH', '');
      url.searchParams.set('EXCD', excd);
      url.searchParams.set('SYMB', sym);

      const r = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey,
          appsecret,
          tr_id: 'HHDFS00000300',
          custtype: 'P',
        },
      });
      const j = await r.json().catch(() => ({}));
      const o = j.output;
      const last = o ? parseFloat(o.last) : NaN;

      if (j.rt_cd === '0' && o && last > 0) {
        // KIS 해외 diff(전일대비)는 절대값만 내려옴 → 등락률 rate의 부호를 입혀 실제 등락폭으로 환산
        const rate = parseFloat(o.rate);
        const diffAbs = Math.abs(parseFloat(o.diff));
        const change = Number.isFinite(rate) && rate < 0 ? -diffAbs : diffAbs;
        return {
          symbol: sym,
          name: sym,
          price: last,
          change,
          changePct: rate,
          currency: 'USD',
          market: excd,
        };
      }
      lastErr = j.msg1 || ('rt_cd ' + j.rt_cd);
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }
  throw new Error('해외 조회 실패(NAS/NYS/AMS 모두): ' + lastErr);
}

// ── 일봉 캔들 (3개월 추이 차트용) ──
// 반환: [{ t: 'YYYYMMDD', c: 종가 }] (오래된→최신 순)
function ymd(d) {
  return (
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0')
  );
}

async function candlesDomestic(sym, token, appkey, appsecret, days) {
  const end = ymd(new Date());
  // 영업일 기준 days개를 확보하려 달력일은 넉넉히(주말·공휴일 보정)
  const start = ymd(new Date(Date.now() - Math.ceil(days * 1.7) * 86400000));
  const url = new URL(`${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', sym);
  url.searchParams.set('FID_INPUT_DATE_1', start);
  url.searchParams.set('FID_INPUT_DATE_2', end);
  url.searchParams.set('FID_PERIOD_DIV_CODE', 'D'); // 일봉
  url.searchParams.set('FID_ORG_ADJ_PRC', '0'); // 0=수정주가

  const r = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: 'FHKST03010100', custtype: 'P' },
  });
  const j = await r.json().catch(() => ({}));
  if (j.rt_cd !== '0' || !Array.isArray(j.output2)) {
    throw new Error('국내 캔들 실패: ' + (j.msg1 || ('rt_cd ' + j.rt_cd)));
  }
  const rows = j.output2
    .filter((o) => o && o.stck_bsop_date && o.stck_clpr)
    .map((o) => ({ t: o.stck_bsop_date, c: parseFloat(o.stck_clpr) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => (a.t < b.t ? -1 : 1));
  return rows.slice(-days);
}

async function candlesOverseas(sym, token, appkey, appsecret, days) {
  let lastErr = '';
  for (const excd of OVERSEAS_EXCD) {
    try {
      const url = new URL(`${KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice`);
      url.searchParams.set('AUTH', '');
      url.searchParams.set('EXCD', excd);
      url.searchParams.set('SYMB', sym);
      url.searchParams.set('GUBN', '0'); // 0=일봉
      url.searchParams.set('BYMD', ''); // 기준일 공란=오늘
      url.searchParams.set('MODP', '1'); // 수정주가 반영

      const r = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, appkey, appsecret, tr_id: 'HHDFS76240000', custtype: 'P' },
      });
      const j = await r.json().catch(() => ({}));
      const arr = j.output2;
      if (j.rt_cd === '0' && Array.isArray(arr) && arr.length) {
        const rows = arr
          .filter((o) => o && o.xymd && o.clos)
          .map((o) => ({ t: o.xymd, c: parseFloat(o.clos) }))
          .filter((x) => x.c > 0)
          .sort((a, b) => (a.t < b.t ? -1 : 1));
        if (rows.length) return rows.slice(-days);
      }
      lastErr = j.msg1 || ('rt_cd ' + j.rt_cd);
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
  }
  throw new Error('해외 캔들 실패(NAS/NYS/AMS 모두): ' + lastErr);
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
    // 파라미터 파싱 (req.query 우선, URL 폴백)
    const params = new URL(req.url, 'http://localhost').searchParams;
    const get = (k) => (req.query && req.query[k] != null ? req.query[k] : params.get(k));
    const type = String(get('type') || '').toLowerCase();

    // ── 일봉 캔들 모드: /api/quote?type=candles&symbol=AAPL&days=90 ──
    if (type === 'candles') {
      const symbol = String(get('symbol') || '').trim().toUpperCase();
      const days = Math.min(400, Math.max(5, parseInt(get('days'), 10) || 90));
      if (!symbol) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: 'symbol 파라미터가 필요합니다 (예: ?type=candles&symbol=AAPL)' }));
      }
      const appkey = process.env.KIS_APPKEY;
      const appsecret = process.env.KIS_APPSECRET;
      const token = await getToken();
      const candles = await withRetry(() =>
        isDomestic(symbol)
          ? candlesDomestic(symbol, token, appkey, appsecret, days)
          : candlesOverseas(symbol, token, appkey, appsecret, days)
      );
      res.statusCode = 200;
      return res.end(JSON.stringify({ ok: true, symbol, candles, ts: Date.now() }));
    }

    // symbols 파라미터 파싱 (req.query 우선, URL 폴백)
    const raw = get('symbols') || '';
    const symbols = String(raw)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: 'symbols 파라미터가 필요합니다 (예: ?symbols=005930,AAPL)' }));
    }

    const appkey = process.env.KIS_APPKEY;
    const appsecret = process.env.KIS_APPSECRET;
    const token = await getToken();

    // 여러 심볼 조회 — 동시 호출 수를 제한하고(레이트리밋 회피) 실패 시 재시도.
    // 한 종목이 끝까지 실패해도 나머지는 정상 반환.
    const CONCURRENCY = 4;
    const settled = await mapLimit(symbols, CONCURRENCY, async (sym) => {
      try {
        return await withRetry(() =>
          isDomestic(sym)
            ? quoteDomestic(sym, token, appkey, appsecret)
            : quoteOverseas(sym, token, appkey, appsecret)
        );
      } catch (e) {
        return { symbol: sym, error: (e && e.message) || String(e) };
      }
    });

    const quotes = settled.filter((q) => q && !q.error);

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, quotes, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
  }
};
