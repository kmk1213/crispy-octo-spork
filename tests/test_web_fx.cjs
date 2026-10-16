'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const fx = require('../web/fx.js');

const NOW = Date.UTC(2026, 9, 16, 3, 4, 5);
const SOURCE_URL = 'https://finance.naver.com/marketindex/exchangeList.naver';
const observed = offset => new Date(NOW + offset).toISOString();

function rate(currency = 'PHP', overrides = {}) {
  return {
    currency,
    krw_per_unit: currency === 'PHP' ? 24.12 : 0.0556,
    quoted_rate: currency === 'PHP' ? 24.12 : 5.56,
    quoted_units: currency === 'PHP' ? 1 : 100,
    observed_at: observed(0), source: '네이버 금융', source_url: SOURCE_URL,
    rate_type: '매매기준율', ...overrides
  };
}

function payload(overrides = {}) {
  return {
    source: '네이버 금융', source_url: SOURCE_URL, observed_at: observed(0),
    status: 'ok', rates: { PHP: rate('PHP'), VND: rate('VND') }, ...overrides
  };
}

test('UMD exposes SourcingFx in a browser without a module loader', () => {
  const context = { URL };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/fx.js'), 'utf8'), context);
  assert.equal(typeof context.SourcingFx.normalizeResponse, 'function');
  assert.equal(typeof context.SourcingFx.makeOfferRate, 'function');
  assert.equal(typeof context.SourcingFx.describeOffer, 'function');
});

test('PHP per-unit and VND per-100 quotes normalize without a 100-fold conversion error', () => {
  const input = payload();
  const before = JSON.stringify(input);
  const result = fx.normalizeResponse(input, NOW);
  assert.deepEqual(result.errors, {});
  assert.equal(result.observed_at, observed(0));
  assert.equal(result.rates.PHP.krw_per_unit, 24.12);
  assert.equal(result.rates.VND.krw_per_unit, 0.0556);
  assert.equal(result.rates.VND.quoted_rate, 5.56);
  assert.equal(result.rates.VND.quoted_units, 100);
  assert.equal(result.rates.VND.krw_per_unit * 100000, 5560);
  assert.equal(result.rates.VND.source_url, SOURCE_URL);
  assert.equal(JSON.stringify(input), before, 'validation must preserve the server response');
});

test('actual VND per-1 quotes are also supported while PHP per-100 quotes are rejected', () => {
  const input = payload({ rates: {
    PHP: rate('PHP', { quoted_units: 100 }),
    VND: rate('VND', { quoted_rate: 0.0556, quoted_units: 1 })
  } });
  const result = fx.normalizeResponse(input, NOW);
  assert.equal(result.rates.PHP, undefined);
  assert.match(result.errors.PHP, /단위/);
  assert.equal(result.rates.VND.krw_per_unit, 0.0556);
  assert.equal(result.errors.VND, undefined);
});

test('a failed or missing PHP quote does not poison an independently valid VND quote', () => {
  for (const badPhp of [undefined, null, { status: 'unavailable' }, rate('PHP', { krw_per_unit: -1 })]) {
    const result = fx.normalizeResponse(payload({ status: 'partial', rates: { PHP: badPhp, VND: rate('VND') } }), NOW);
    assert.ok(result.errors.PHP);
    assert.equal(result.errors.VND, undefined);
    assert.equal(result.rates.VND.currency, 'VND');
    assert.equal(result.rates.PHP, undefined);
  }
});

test('missing VND never gets a fabricated default and top-level unavailable returns both errors', () => {
  const partial = fx.normalizeResponse(payload({ status: 'partial', rates: { PHP: rate('PHP') } }), NOW);
  assert.equal(partial.rates.PHP.currency, 'PHP');
  assert.equal(partial.rates.VND, undefined);
  assert.ok(partial.errors.VND);
  for (const input of [payload({ status: 'unavailable' }), payload({ status: 'error' }), null, [], 'invalid']) {
    const result = fx.normalizeResponse(input, NOW);
    assert.deepEqual(result.rates, {});
    assert.deepEqual(Object.keys(result.errors), ['PHP', 'VND']);
  }
});

test('top-level freshness expires after 20 minutes and rejects clock skew over 5 minutes', () => {
  for (const offset of [-20 * 60 * 1000 - 1, 5 * 60 * 1000 + 1]) {
    const result = fx.normalizeResponse(payload({ observed_at: observed(offset) }), NOW);
    assert.deepEqual(result.rates, {});
    assert.ok(result.errors.PHP);
    assert.ok(result.errors.VND);
  }
  for (const offset of [-20 * 60 * 1000, 5 * 60 * 1000]) {
    const result = fx.normalizeResponse(payload({ observed_at: observed(offset) }), NOW);
    assert.equal(Object.keys(result.rates).length, 2, 'freshness boundaries are inclusive');
  }
});

test('per-currency timestamps are independently fresh and must contain an explicit timezone', () => {
  for (const observed_at of [observed(-20 * 60 * 1000 - 1), observed(5 * 60 * 1000 + 1), 'not-a-date', '2026-10-16T03:04:05', '2026-02-30T03:04:05Z']) {
    const result = fx.normalizeResponse(payload({ rates: { PHP: rate('PHP', { observed_at }), VND: rate('VND') } }), NOW);
    assert.equal(result.rates.PHP, undefined);
    assert.ok(result.errors.PHP);
    assert.equal(result.rates.VND.currency, 'VND');
  }
  const offsetTime = '2026-10-16T12:04:05+09:00';
  assert.equal(fx.normalizeResponse(payload({ observed_at: offsetTime }), NOW).rates.PHP.currency, 'PHP');
});

test('currency labels, finite positive values, and quoted/normalized arithmetic must match', () => {
  const invalidOverrides = [
    { currency: 'VND' }, { currency: 'php' },
    ...[0, -1, NaN, Infinity, 1e12 + 1, '24.12', null].map(krw_per_unit => ({ krw_per_unit })),
    { quoted_rate: 0 }, { quoted_rate: Infinity }, { quoted_units: '1' },
    { krw_per_unit: 24.12, quoted_rate: 2412, quoted_units: 1 }
  ];
  for (const overrides of invalidOverrides) {
    const result = fx.normalizeResponse(payload({ rates: { PHP: rate('PHP', overrides), VND: rate('VND') } }), NOW);
    assert.equal(result.rates.PHP, undefined);
    assert.ok(result.errors.PHP);
    assert.equal(result.rates.VND.currency, 'VND');
  }
  const mismatch = fx.normalizeResponse(payload({ rates: { VND: rate('VND', { krw_per_unit: 5.56 }) } }), NOW);
  assert.equal(mismatch.rates.VND, undefined);
  assert.match(mismatch.errors.VND, /환산/);
  const rounded = fx.normalizeResponse(payload({ rates: { PHP: rate('PHP', { krw_per_unit: 24.1200000001 }) } }), NOW);
  assert.equal(rounded.rates.PHP.currency, 'PHP', 'harmless floating-point differences are accepted');
});

test('only the canonical HTTPS Naver Finance source is accepted at both provenance levels', () => {
  const unsafeUrls = [
    'http://finance.naver.com/marketindex/exchangeList.naver',
    'https://finance.naver.com.evil.example/marketindex/exchangeList.naver',
    'https://evil.example/marketindex/exchangeList.naver',
    'https://finance.naver.com@evil.example/marketindex/exchangeList.naver',
    'https://user:secret@finance.naver.com/marketindex/exchangeList.naver',
    'https://finance.naver.com:444/marketindex/exchangeList.naver',
    'https://finance.naver.com/other/exchangeList.naver',
    SOURCE_URL + '?token=do-not-accept', SOURCE_URL + '#other',
    'javascript:alert(1)', '', null
  ];
  for (const source_url of unsafeUrls) {
    assert.deepEqual(fx.normalizeResponse(payload({ source_url }), NOW).rates, {});
    const partial = fx.normalizeResponse(payload({ rates: { PHP: rate('PHP', { source_url }), VND: rate('VND') } }), NOW);
    assert.equal(partial.rates.PHP, undefined);
    assert.equal(partial.rates.VND.currency, 'VND');
  }
  assert.deepEqual(fx.normalizeResponse(payload({ source: '임의 금융' }), NOW).rates, {});
  assert.equal(fx.normalizeResponse(payload({ rates: { PHP: rate('PHP', { rate_type: '현찰 살 때' }) } }), NOW).rates.PHP, undefined);
});

test('normalization whitelists quote fields and never copies arbitrary secrets or response extras', () => {
  const result = fx.normalizeResponse(payload({ api_key: 'not-for-clients', rates: {
    PHP: rate('PHP', { token: 'not-for-offers' }), VND: rate('VND')
  } }), NOW);
  assert.equal(result.api_key, undefined);
  assert.equal(result.rates.PHP.token, undefined);
  assert.deepEqual(Object.keys(result.rates.PHP).sort(), [
    'currency', 'krw_per_unit', 'quoted_rate', 'quoted_units', 'observed_at', 'source', 'source_url', 'rate_type'
  ].sort());
});

test('makeOfferRate captures the verified quote and rejects malformed snapshots', () => {
  const snapshot = fx.makeOfferRate(rate('VND'));
  assert.deepEqual(snapshot, {
    exchange_rate: 0.0556, fx_mode: 'naver', fx_source: '네이버 금융',
    fx_source_url: SOURCE_URL, fx_observed_at: observed(0),
    fx_quoted_rate: 5.56, fx_quoted_units: 100, fx_rate_type: '매매기준율'
  });
  assert.throws(() => fx.makeOfferRate(rate('VND', { krw_per_unit: 5.56 })), /환산/);
  assert.throws(() => fx.makeOfferRate(rate('USD')), /통화/);
  assert.throws(() => fx.makeOfferRate(rate('PHP', { source: '임의 금융' })), /출처/);
  assert.throws(() => fx.makeOfferRate(null), /통화/);
});

test('labels distinguish legacy/manual, genuine Naver provenance, and demo without trusting arbitrary source names', () => {
  assert.equal(fx.describeOffer({ market: 'PH_SHOPEE', exchange_rate: 24 }), '직접 입력 환율');
  assert.equal(fx.describeOffer({ fx_mode: 'manual', fx_source: '네이버 금융' }), '직접 입력 환율');
  assert.equal(fx.describeOffer({ fx_source: '임의 금융' }), '직접 입력 환율');
  const offer = { market: 'VN_SHOPEE', ...fx.makeOfferRate(rate('VND')) };
  assert.equal(fx.describeOffer(offer), '네이버 금융 · 매매기준율');
  assert.equal(fx.describeOffer(offer, true), '예시 환율 · 실제 시세 아님');
  assert.equal(fx.describeOffer(null, true), '예시 환율 · 실제 시세 아님');
  assert.equal(fx.describeOffer({ ...offer, fx_source: '임의 금융 <script>' }), '자동 환율 출처 확인 필요');
  assert.equal(fx.describeOffer({ ...offer, fx_source_url: 'https://evil.example' }), '자동 환율 출처 확인 필요');
  assert.equal(fx.describeOffer({ ...offer, exchange_rate: 5.56 }), '자동 환율 출처 확인 필요');
  assert.equal(fx.describeOffer({ fx_mode: 'naver' }), '자동 환율 출처 확인 필요');
});
