(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SourcingFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SOURCE = '네이버 금융';
  const SOURCE_URL = 'https://finance.naver.com/marketindex/exchangeList.naver';
  const RATE_TYPE = '매매기준율';
  const CURRENCIES = ['PHP', 'VND'];
  const MAX_AGE_MS = 20 * 60 * 1000;
  const MAX_FUTURE_MS = 5 * 60 * 1000;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e12;

  function validSource(source, sourceUrl) {
    if (source !== SOURCE || typeof sourceUrl !== 'string') return false;
    try {
      const url = new URL(sourceUrl);
      return url.protocol === 'https:' && url.hostname === 'finance.naver.com' &&
        !url.username && !url.password && !url.port && !url.search && !url.hash &&
        url.pathname === '/marketindex/exchangeList.naver';
    } catch (_) {
      return false;
    }
  }

  function timestamp(value) {
    if (typeof value !== 'string') return null;
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!parts) return null;
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
        hour > 23 || minute > 59 || second > 59) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function timeError(observedAt, nowMs) {
    const observedMs = timestamp(observedAt);
    if (observedMs === null) return '환율 조회 시간을 확인할 수 없습니다.';
    if (nowMs !== undefined) {
      if (observedMs - nowMs > MAX_FUTURE_MS) return '환율 조회 시간이 미래로 표시되어 사용할 수 없습니다.';
      if (nowMs - observedMs > MAX_AGE_MS) return '조회한 환율이 20분을 지나 다시 조회해야 합니다.';
    }
    return '';
  }

  function validateRate(rate, currency, nowMs) {
    if (!record(rate)) return currency + ' 환율을 받아오지 못했습니다.';
    if (rate.currency !== currency) return currency + ' 환율의 통화 정보가 일치하지 않습니다.';
    if (!validSource(rate.source, rate.source_url) || rate.rate_type !== RATE_TYPE) {
      return currency + ' 환율의 네이버 금융 출처를 확인할 수 없습니다.';
    }
    if (!positive(rate.krw_per_unit) || !positive(rate.quoted_rate)) return currency + ' 환율은 유효한 양수여야 합니다.';
    const units = currency === 'PHP' ? [1] : [1, 100];
    if (!units.includes(rate.quoted_units)) return currency + ' 환율의 고시 단위를 확인하세요.';
    const normalized = rate.quoted_rate / rate.quoted_units;
    const tolerance = Math.max(1e-12, Math.abs(normalized) * 1e-8);
    if (Math.abs(rate.krw_per_unit - normalized) > tolerance) {
      return currency + ' 환율과 고시 단위의 환산 값이 일치하지 않습니다.';
    }
    return timeError(rate.observed_at, nowMs);
  }

  function normalizedRate(rate, currency) {
    return {
      currency, krw_per_unit: rate.krw_per_unit, quoted_rate: rate.quoted_rate,
      quoted_units: rate.quoted_units, observed_at: rate.observed_at,
      source: SOURCE, source_url: SOURCE_URL, rate_type: RATE_TYPE
    };
  }

  /** Validate each currency independently; missing/unavailable data never becomes a default rate. */
  function normalizeResponse(payload, nowMs = Date.now()) {
    const result = { rates: {}, errors: {}, observed_at: '' };
    let error = '';
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      error = '현재 시간을 확인할 수 없어 환율을 사용할 수 없습니다.';
    } else if (!record(payload)) {
      error = '환율 응답 형식을 확인하세요.';
    } else if (!validSource(payload.source, payload.source_url)) {
      error = '네이버 금융 환율 출처를 확인할 수 없습니다.';
    } else if (!['ok', 'partial'].includes(payload.status)) {
      error = '네이버 금융에서 사용 가능한 환율을 받아오지 못했습니다.';
    } else {
      error = timeError(payload.observed_at, nowMs);
      if (!error && !record(payload.rates)) error = '환율 응답 형식을 확인하세요.';
    }
    if (error) {
      for (const currency of CURRENCIES) result.errors[currency] = error;
      return result;
    }
    result.observed_at = payload.observed_at;
    for (const currency of CURRENCIES) {
      const rate = payload.rates[currency];
      const reason = validateRate(rate, currency, nowMs);
      if (reason) result.errors[currency] = reason;
      else result.rates[currency] = normalizedRate(rate, currency);
    }
    return result;
  }

  /** Capture already validated quote provenance without silently changing a saved offer later. */
  function makeOfferRate(rate) {
    if (!record(rate) || !CURRENCIES.includes(rate.currency)) throw new Error('지원하는 환율의 통화 정보를 확인하세요.');
    const error = validateRate(rate, rate.currency);
    if (error) throw new Error(error);
    return {
      exchange_rate: rate.krw_per_unit,
      fx_mode: 'naver', fx_source: SOURCE, fx_source_url: SOURCE_URL,
      fx_observed_at: rate.observed_at, fx_quoted_rate: rate.quoted_rate,
      fx_quoted_units: rate.quoted_units, fx_rate_type: RATE_TYPE
    };
  }

  /** Describe stored provenance, rather than claiming that an old snapshot is a current quote. */
  function describeOffer(offer, demo = false) {
    if (demo === true) return '예시 환율 · 실제 시세 아님';
    if (!record(offer) || offer.fx_mode !== 'naver') return '직접 입력 환율';
    const currency = typeof offer.market === 'string' && offer.market.startsWith('VN_') ? 'VND' :
      typeof offer.market === 'string' && offer.market.startsWith('PH_') ? 'PHP' :
      offer.fx_quoted_units === 100 ? 'VND' : 'PHP';
    const error = validateRate({
      currency, krw_per_unit: offer.exchange_rate,
      quoted_rate: offer.fx_quoted_rate, quoted_units: offer.fx_quoted_units,
      observed_at: offer.fx_observed_at, source: offer.fx_source,
      source_url: offer.fx_source_url, rate_type: offer.fx_rate_type
    }, currency);
    return error ? '자동 환율 출처 확인 필요' : '네이버 금융 · 매매기준율';
  }

  return Object.freeze({ normalizeResponse, makeOfferRate, describeOffer });
});
