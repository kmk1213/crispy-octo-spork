'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../web/core.js');

function offer(group, market = 'PH_SHOPEE', overrides = {}) {
  return {
    group, market, sale_price: 1000, exchange_rate: 20, fee_pct: 10,
    tax_pct: 5, outbound_shipping: 3000, other_cost: 0, refund_pct: 2,
    confirmed: true, ...overrides
  };
}

test('UMD exposes a browser global without requiring a module loader', () => {
  const context = { URL, URLSearchParams, TextEncoder };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/core.js'), 'utf8'), context);
  assert.equal(typeof context.SourcingCore.compare, 'function');
  assert.equal(context.SourcingCore.MARKETS.VN_SHOPEE.currency, 'VND');
  assert.equal(Object.keys(context.SourcingCore.PLATFORMS).length, 4);
});

test('landed price, fees, reserves, ROI and break-even match the server formulas', () => {
  const payload = {
    rows: [
      { title: '동일 상품', source: 'A', price: 10000, shipping: 1000, group: 'A-50ml' },
      { title: '동일 상품', source: 'B', price: 10500, shipping: 0, group: 'A-50ml' }
    ],
    settings: { sale_price: 20, exchange_rate: 1000, fee_pct: 10, tax_pct: 5, refund_pct: 2, outbound_shipping: 3000, packaging: 500 }
  };
  const before = JSON.stringify(payload);
  const { rows, settings } = core.analyze(payload);
  const [cheap, expensive] = rows;
  assert.equal(cheap.source, 'B');
  assert.equal(cheap.purchase_total, 10500);
  assert.equal(cheap.rank, 1);
  assert.equal(expensive.rank, 2);
  assert.equal(cheap.revenue, 20000);
  assert.equal(cheap.fee, 2000);
  assert.equal(cheap.tax, 1000);
  assert.equal(cheap.refund_reserve, 400);
  assert.equal(cheap.profit, 2600);
  assert.equal(cheap.total_cost, 17400);
  assert.equal(cheap.roi_pct, 2600 / 14000 * 100);
  assert.equal(cheap.margin_pct, 13);
  assert.equal(cheap.break_even, 14000 / 0.83);
  assert.equal(cheap.recommended, true);
  assert.equal(settings.min_roi, 10);
  assert.equal(JSON.stringify(payload), before, 'calculation must preserve input data');
});

test('all per-item fixed costs are included and percentages are based on revenue', () => {
  const { rows } = core.analyze({
    rows: [{ title: '상품', price: 1000, shipping: 100 }],
    settings: { sale_price: 500, exchange_rate: 20, purchase_shipping: 200, outbound_shipping: 300, packaging: 50, other_cost: 75, fee_pct: 10, tax_pct: 5, refund_pct: 2 }
  });
  assert.equal(rows[0].purchase_total, 1300);
  assert.equal(rows[0].total_cost, 3425);
  assert.equal(rows[0].profit, 6575);
  assert.equal(rows[0].roi_pct, 6575 / 1725 * 100);
  assert.equal(rows[0].rank, null, 'unverified product identity must not have a price ranking');
});

test('zero denominators and rates totaling 100% or more remain explicit', () => {
  const empty = core.analyze({ rows: [{ title: '무료', price: 0, url: 'javascript:alert(1)' }], settings: { sale_price: 0, outbound_shipping: 0, packaging: 0 } }).rows[0];
  assert.equal(empty.roi_pct, null);
  assert.equal(empty.margin_pct, null);
  assert.equal(empty.recommended, false);
  assert.equal(empty.url, '');
  const fullFee = core.analyze({ rows: [{ title: '상품', price: 1000 }], settings: { fee_pct: 90, tax_pct: 10 } }).rows[0];
  assert.equal(fullFee.break_even, null);
  assert.ok(fullFee.profit < 0);
});

test('invalid prices, settings, shapes, and row limits produce readable errors', () => {
  for (const price of [-1, 'NaN', 'abc', Infinity, null, '', ' ', [], {}, '0x10', 1e12 + 1]) {
    assert.throws(() => core.analyze({ rows: [{ title: '상품', price }] }), /숫자/);
  }
  for (const input of [null, [], '상품', 1]) assert.throws(() => core.analyze(input), /객체/);
  for (const settings of [null, [], 'bad']) assert.throws(() => core.analyze({ settings }), /비용 설정/);
  for (const setting of ['fee_pct', 'tax_pct', 'refund_pct']) assert.throws(() => core.analyze({ settings: { [setting]: 101 } }), /100%/);
  assert.throws(() => core.analyze({ settings: { exchange_rate: 0 } }), /환율/);
  assert.throws(() => core.analyze({ rows: [{ title: '  ', price: 1 }] }), /상품명/);
  assert.throws(() => core.analyze({ rows: new Array(1001).fill({ title: 'x', price: 1 }) }), /1,000/);
  assert.throws(() => core.analyze({ rows: {} }), /1,000/);
});

test('market comparison recommends three distinct products and picks the best supplier and destination', () => {
  const payload = {
    rows: [['A', 10000], ['A', 11000], ['B', 12000], ['C', 13000], ['D', 14000]].map(([group, price]) => ({ title: group, group, price, source: '다이소' })),
    offers: ['A', 'B', 'C', 'D'].map(group => offer(group)).concat(offer('A', 'VN_LAZADA', { sale_price: 600000, exchange_rate: 0.05 })),
    settings: { min_roi: 0 }
  };
  const { rows, top, note } = core.compare(payload);
  assert.deepEqual(top.map(row => row.group), ['A', 'B', 'C']);
  assert.deepEqual(top.map(row => row.recommendation_rank), [1, 2, 3]);
  assert.equal(top[0].currency, 'VND');
  assert.equal(top[0].platform, 'Lazada');
  assert.equal(top[0].revenue, 30000);
  assert.equal(top[0].profit, 11400);
  assert.equal(top[0].price, 10000);
  assert.equal(rows[0], top[0]);
  assert.match(note, /실시간 시장 최저가는 검증하지 않았습니다/);
});

test('ROI and profit select different best products, exclude losses, and enforce the target', () => {
  const payload = {
    rows: [['A', 10000], ['B', 1000], ['C', 100000]].map(([group, price]) => ({ title: group, group, price })),
    offers: [offer('A', 'PH_SHOPEE', { sale_price: 1600 }), offer('B'), offer('C')],
    settings: { min_roi: 0 }
  };
  assert.equal(core.compare(payload).top[0].group, 'A');
  const byRoi = core.compare({ ...payload, metric: 'roi_pct' });
  assert.equal(byRoi.top[0].group, 'B');
  assert.ok(!byRoi.top.some(row => row.group === 'C'));
  assert.deepEqual(core.compare({ ...payload, settings: { min_roi: 10000 } }).top, []);
});

test('confirmation is strict, unmatched groups are reported once, and whitespace cannot duplicate a product recommendation', () => {
  const unconfirmed = core.compare({
    rows: [{ title: 'A', group: 'A', price: 1000 }],
    offers: [offer('A', 'PH_SHOPEE', { confirmed: 'true' }), offer('missing'), offer('missing')]
  });
  assert.deepEqual(unconfirmed.top, []);
  assert.deepEqual(unconfirmed.unmatched_groups, ['missing']);
  const trimmed = core.compare({
    rows: [{ title: 'A', group: ' A ', price: 1000 }, { title: 'A', group: 'A', price: 900 }],
    offers: [offer('A')]
  });
  assert.equal(trimmed.top.length, 1);
  assert.equal(trimmed.top[0].price, 900);
  assert.equal(trimmed.top[0].group, 'A');
});

test('destination-specific figures cannot be silently defaulted and market keys must be supported', () => {
  const rows = [{ title: 'A', group: 'A', price: 1000 }];
  for (const key of ['sale_price', 'exchange_rate', 'fee_pct', 'tax_pct', 'outbound_shipping', 'other_cost', 'refund_pct']) {
    const missing = offer('A');
    delete missing[key];
    assert.throws(() => core.compare({ rows, offers: [missing] }), new RegExp(key));
    assert.throws(() => core.compare({ rows, offers: [{ ...offer('A'), [key]: '' }] }), new RegExp(key));
  }
  for (const market of [['PH_SHOPEE'], 'UNKNOWN', '__proto__', 'toString']) {
    assert.throws(() => core.compare({ rows, offers: [offer('A', market)] }), /플랫폼/);
  }
  assert.throws(() => core.compare({ rows, offers: [offer('')] }), /동일상품 그룹/);
  assert.throws(() => core.compare({ rows, metric: 'sales' }), /추천 기준/);
  assert.throws(() => core.compare({ rows, offers: new Array(201).fill(offer('A')) }), /200/);
});

test('CSV reads BOM, CRLF, quoted commas, escaped quotes and quoted line breaks', () => {
  const rows = core.parseCsv('\uFEFFtitle,price,source,shipping,group,url\r\n"선크림, 50ml",10000,"몰 ""A""",500,A,https://example.com\r\n"두 줄\r\n상품",2000,다이소,0,B,\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '선크림, 50ml');
  assert.equal(rows[0].source, '몰 "A"');
  assert.equal(rows[1].title, '두 줄\r\n상품');
  assert.equal(rows[1].url, '');
  assert.equal(rows[0].price, '10000');
  assert.equal(core.analyze({ rows }).rows[0].price, 2000);
});

test('CSV skips empty physical lines but preserves quoted empty fields for validation', () => {
  assert.equal(core.parseCsv('\n\r\ntitle,price\n\n상품,1000\n\n').length, 1);
  assert.deepEqual(core.parseCsv('title,price\n'), []);
  assert.throws(() => core.parseCsv('title,price\n"",1000\n'), /상품명/);
  assert.throws(() => core.parseCsv('title,price\n상품,""\n'), /숫자/);
});

test('CSV rejects incorrect columns, ambiguous headers, invalid quoting, and missing required headers', () => {
  for (const invalid of ['title,price\n상품,1000,extra', 'title,price,shipping\n상품,1000']) {
    assert.throws(() => core.parseCsv(invalid), /열 개수/);
  }
  assert.throws(() => core.parseCsv('title,price,price\n상품,100,200'), /중복/);
  assert.throws(() => core.parseCsv('title,price,\n상품,100,'), /열 이름/);
  for (const invalid of ['title,price\n"상품,1000', 'title,price\n상"품,1000', 'title,price\n"상품"x,1000']) {
    assert.throws(() => core.parseCsv(invalid), /따옴표/);
  }
  assert.throws(() => core.parseCsv('name,cost\n상품,1000'), /title, price/);
  assert.throws(() => core.parseCsv(''), /title, price/);
  assert.throws(() => core.parseCsv('title,price\n상품,-1'), /숫자/);
});

test('CSV enforces row, field, and uploaded byte-size limits', () => {
  assert.equal(core.parseCsv('title,price\n' + '상품,1000\n'.repeat(1000)).length, 1000);
  assert.throws(() => core.parseCsv('title,price\n' + '상품,1000\n'.repeat(1001)), /1,000/);
  assert.throws(() => core.parseCsv('title,price\n' + 'x'.repeat(128 * 1024 + 1) + ',1000'), /128KB/);
  assert.throws(() => core.parseCsv('가'.repeat(700000)), /2MB/);
});

test('CSV special object keys cannot pollute prototypes', () => {
  const rows = core.parseCsv('title,price,__proto__\n상품,1000,hello');
  assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
  assert.equal(rows[0].__proto__, 'hello');
  assert.equal({}.hello, undefined);
});

test('eight search links point to supported real sites and encode the keyword safely', () => {
  const links = core.searchLinks(' 선크림 & 50ml ');
  assert.equal(Object.keys(links).length, 8);
  assert.equal(new URL(links['네이버쇼핑']).searchParams.get('query'), '선크림 & 50ml');
  assert.equal(new URL(links['필리핀 Shopee']).hostname, 'shopee.ph');
  assert.equal(new URL(links['베트남 Lazada']).searchParams.get('q'), '선크림 & 50ml');
  assert.throws(() => core.searchLinks('   '), /검색어/);
});
