(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SourcingCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PLATFORMS = Object.freeze({
    '올리브영': 'https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query=',
    '다이소': 'https://www.daisomall.co.kr/ds/search/totalSearch?searchTerm=',
    '쿠팡': 'https://www.coupang.com/np/search?q=',
    '네이버쇼핑': 'https://search.shopping.naver.com/search/all?query='
  });
  const MARKETS = Object.freeze({
    PH_SHOPEE: Object.freeze({ country: '필리핀', platform: 'Shopee', currency: 'PHP', search: 'https://shopee.ph/search?keyword=' }),
    PH_LAZADA: Object.freeze({ country: '필리핀', platform: 'Lazada', currency: 'PHP', search: 'https://www.lazada.com.ph/catalog/?q=' }),
    VN_SHOPEE: Object.freeze({ country: '베트남', platform: 'Shopee', currency: 'VND', search: 'https://shopee.vn/search?keyword=' }),
    VN_LAZADA: Object.freeze({ country: '베트남', platform: 'Lazada', currency: 'VND', search: 'https://www.lazada.vn/catalog/?q=' })
  });
  const DEFAULTS = Object.freeze({
    sale_price: 20000, exchange_rate: 1, fee_pct: 12, tax_pct: 0,
    purchase_shipping: 0, outbound_shipping: 3000, packaging: 500,
    other_cost: 0, refund_pct: 0, min_roi: 10
  });
  const NOTE = '입력한 판매가·비용 기준 예상 수익 추천입니다. 실제 수요·판매량·실시간 시장 최저가는 검증하지 않았습니다.';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => value == null ? '' : String(value);

  function number(value, name) {
    const numericString = typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim());
    if (typeof value !== 'number' && typeof value !== 'boolean' && !numericString) {
      throw new Error(name + ': 숫자를 입력하세요.');
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1e12) {
      throw new Error(name + ': 유효한 0 이상의 숫자를 입력하세요.');
    }
    return parsed;
  }

  function settings(data) {
    if (!isRecord(data)) throw new Error('비용 설정은 항목과 숫자로 된 객체여야 합니다.');
    const result = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      result[key] = number(own(data, key) ? data[key] : fallback, key);
    }
    for (const key of ['fee_pct', 'tax_pct', 'refund_pct']) {
      if (result[key] > 100) throw new Error(key + ': 100% 이하여야 합니다.');
    }
    if (result.exchange_rate === 0) throw new Error('환율은 0보다 커야 합니다.');
    return result;
  }

  function safeUrl(value) {
    const candidate = text(value);
    if (!/^https?:\/\//i.test(candidate)) return '';
    try {
      const url = new URL(candidate);
      return ['http:', 'https:'].includes(url.protocol) && url.hostname ? candidate : '';
    } catch (_) {
      return '';
    }
  }

  function calculate(row, config) {
    const price = number(row.price, '사입가');
    const shipping = number(row.shipping == null || row.shipping === '' ? 0 : row.shipping, '판매처 배송료');
    const revenue = config.sale_price * config.exchange_rate;
    const purchase = price + shipping + config.purchase_shipping;
    const fixed = purchase + config.outbound_shipping + config.packaging + config.other_cost;
    const rate = (config.fee_pct + config.tax_pct + config.refund_pct) / 100;
    const fee = revenue * config.fee_pct / 100;
    const tax = revenue * config.tax_pct / 100;
    const reserve = revenue * config.refund_pct / 100;
    const profit = revenue - fixed - fee - tax - reserve;
    return {
      ...row, price, shipping, purchase_total: purchase, revenue, fee, tax,
      refund_reserve: reserve, total_cost: fixed + fee + tax + reserve, profit,
      roi_pct: fixed ? profit / fixed * 100 : null,
      margin_pct: revenue ? profit / revenue * 100 : null,
      break_even: rate < 1 ? fixed / (1 - rate) : null
    };
  }

  function analyze(data) {
    if (!isRecord(data)) throw new Error('요청 데이터는 상품 목록과 비용 설정을 담은 객체여야 합니다.');
    const config = settings(own(data, 'settings') ? data.settings : {});
    const input = own(data, 'rows') ? data.rows : [];
    if (!Array.isArray(input) || input.length > 1000) throw new Error('상품은 최대 1,000개입니다.');
    const rows = input.map(row => {
      if (!isRecord(row) || !text(row.title).trim()) throw new Error('상품명이 필요합니다.');
      const clean = {};
      for (const key of ['title', 'source', 'group']) clean[key] = text(row[key]).slice(0, 2000);
      clean.price = row.price;
      clean.shipping = row.shipping;
      clean.url = safeUrl(row.url);
      return calculate(clean, config);
    });
    rows.sort((a, b) => a.purchase_total - b.purchase_total);
    const groups = new Map();
    for (const row of rows) {
      const group = row.group.trim();
      row.rank = null;
      if (group) {
        row.rank = (groups.get(group) || 0) + 1;
        groups.set(group, row.rank);
      }
      row.recommended = row.profit > 0 && row.roi_pct !== null && row.roi_pct >= config.min_roi;
    }
    return { rows, settings: config };
  }

  function compare(data) {
    const analysis = analyze(data);
    const offers = own(data, 'offers') ? data.offers : [];
    if (!Array.isArray(offers) || offers.length > 200) throw new Error('판매 시나리오는 최대 200개입니다.');
    const metric = own(data, 'metric') ? data.metric : 'profit';
    if (!['profit', 'roi_pct'].includes(metric)) throw new Error('추천 기준은 profit 또는 roi_pct입니다.');
    const rows = [];
    const unmatched = new Set();
    const required = ['sale_price', 'exchange_rate', 'fee_pct', 'tax_pct', 'outbound_shipping', 'other_cost', 'refund_pct'];
    offers.forEach((offer, index) => {
      if (!isRecord(offer) || typeof offer.market !== 'string' || !own(MARKETS, offer.market)) {
        throw new Error('필리핀·베트남의 지원 판매 플랫폼을 선택하세요.');
      }
      const group = text(offer.group).trim();
      if (!group) throw new Error('판매 시나리오에 동일상품 그룹이 필요합니다.');
      const destination = {};
      for (const key of required) {
        if (!own(offer, key) || !text(offer[key]).trim()) {
          throw new Error('판매 시나리오 ' + (index + 1) + ': ' + key + ' 값을 입력하세요. 해당 없으면 0입니다.');
        }
        destination[key] = offer[key];
      }
      const config = settings({ ...analysis.settings, ...destination });
      const matches = analysis.rows.filter(row => row.group.trim() === group);
      if (!matches.length) unmatched.add(group);
      for (const row of matches) {
        const market = MARKETS[offer.market];
        const result = {
          ...calculate(row, config), group, market: offer.market,
          country: market.country, platform: market.platform, currency: market.currency,
          sale_price: config.sale_price, exchange_rate: config.exchange_rate,
          sale_url: safeUrl(offer.sale_url), confirmed: offer.confirmed === true,
          offer_index: index, assumptions: { ...config }, recommendation_rank: null
        };
        result.recommended = result.confirmed && result.profit > 0 && result.roi_pct !== null && result.roi_pct >= config.min_roi;
        rows.push(result);
      }
    });
    const candidates = rows.filter(row => row.recommended).sort((a, b) =>
      b[metric] - a[metric] || b.profit - a.profit || a.purchase_total - b.purchase_total ||
      (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
    const top = [];
    const seen = new Set();
    for (const row of candidates) {
      if (seen.has(row.group)) continue;
      seen.add(row.group);
      row.recommendation_rank = top.length + 1;
      top.push(row);
      if (top.length === 3) break;
    }
    rows.sort((a, b) => b.profit - a.profit);
    return { rows, top, unmatched_groups: [...unmatched].sort(), metric, note: NOTE };
  }

  function parseCsv(input) {
    if (typeof input !== 'string') throw new Error('UTF-8 CSV 파일을 사용하세요.');
    if (new TextEncoder().encode(input).length > 2 * 1024 * 1024) throw new Error('파일이 너무 큽니다. 2MB 이하 CSV를 사용하세요.');
    const source = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input;
    const records = [];
    let fields = [];
    let field = '';
    let quoted = false;
    let closedQuote = false;
    let started = false;
    const append = character => {
      field += character;
      if (field.length > 128 * 1024) throw new Error('CSV 항목은 128KB 이하여야 합니다.');
    };
    const finishField = () => {
      fields.push(field);
      field = '';
      closedQuote = false;
    };
    const finishRecord = () => {
      if (started || fields.length || field) {
        finishField();
        records.push(fields);
        if (records.length > 1001) throw new Error('상품은 최대 1,000개입니다.');
      }
      fields = [];
      field = '';
      closedQuote = false;
      started = false;
    };
    for (let index = 0; index < source.length; index++) {
      const character = source[index];
      if (quoted) {
        if (character === '"') {
          if (source[index + 1] === '"') {
            append('"');
            index++;
          } else {
            quoted = false;
            closedQuote = true;
          }
        } else append(character);
        continue;
      }
      if (character === ',') {
        started = true;
        finishField();
      } else if (character === '\n' || character === '\r') {
        finishRecord();
        if (character === '\r' && source[index + 1] === '\n') index++;
      } else if (character === '"') {
        if (field.length || closedQuote) throw new Error('CSV 따옴표 형식을 확인하세요.');
        started = true;
        quoted = true;
      } else {
        if (closedQuote) throw new Error('CSV 닫는 따옴표 뒤에는 쉼표나 줄바꿈이 필요합니다.');
        started = true;
        append(character);
      }
    }
    if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.');
    finishRecord();
    const headers = (records.shift() || []).map(header => header.trim());
    if (!headers.includes('title') || !headers.includes('price')) throw new Error('CSV에 title, price 열이 필요합니다.');
    if (headers.some(header => !header) || new Set(headers).size !== headers.length) {
      throw new Error('CSV 열 이름은 비어 있거나 중복될 수 없습니다.');
    }
    const rows = records.map((record, index) => {
      if (record.length !== headers.length) throw new Error('CSV ' + (index + 2) + '번째 데이터의 열 개수가 제목과 다릅니다.');
      return Object.fromEntries(headers.map((header, column) => [header, record[column]]));
    });
    analyze({ rows });
    return rows;
  }

  function searchLinks(keyword) {
    const query = text(keyword).trim().slice(0, 100);
    if (!query) throw new Error('검색어를 입력하세요.');
    const encoded = new URLSearchParams({ q: query }).toString().slice(2);
    const links = {};
    for (const [name, base] of Object.entries(PLATFORMS)) links[name] = base + encoded;
    for (const market of Object.values(MARKETS)) links[market.country + ' ' + market.platform] = market.search + encoded;
    return links;
  }

  return Object.freeze({ DEFAULTS, MARKETS, PLATFORMS, analyze, compare, parseCsv, searchLinks });
});
