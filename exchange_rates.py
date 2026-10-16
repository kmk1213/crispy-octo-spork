"""Bounded NAVER Finance exchange-list reader for PHP and VND.

Only the published ``td.sale`` (매매기준율) cell is accepted. The NAVER
exchange-list HTML could not be retrieved in this environment: its HTTPS proxy
refused the connection. Parser tests therefore use explicitly synthetic fixtures,
not captured responses, and do not establish live integration readiness.
"""

from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import re
from threading import Lock
import time
from urllib.parse import urljoin, urlsplit

import requests


SOURCE = '네이버 금융'
SOURCE_URL = 'https://finance.naver.com/marketindex/exchangeList.naver'
CURRENCIES = ('PHP', 'VND')
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = (5, 12)
SUCCESS_TTL = 600
FAILURE_TTL = 30
_CACHE = {}
_CACHE_LOCK = Lock()


class ExchangeRateError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _same_source_url(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == 'https' and parsed.hostname == 'finance.naver.com'
                and parsed.port in (None, 443) and not parsed.username and not parsed.password)
    except ValueError:
        return False


def _decode(body, encoding):
    if not encoding or encoding.lower() in ('iso-8859-1', 'ascii'):
        meta = re.search(br'charset\s*=\s*[\"\']?\s*([a-zA-Z0-9_-]+)', body[:4096], re.I)
        encoding = meta.group(1).decode('ascii') if meta else 'utf-8'
    try:
        return body.decode(encoding, errors='replace')
    except (LookupError, TypeError):
        return body.decode('utf-8', errors='replace')


def _fetch():
    """Use the fixed official HTTPS origin with default proxies and verified TLS."""
    url = SOURCE_URL
    headers = {'User-Agent': 'MKCommunication/1.0 (public exchange-rate reader)',
               'Accept': 'text/html'}
    for redirects in range(4):
        response = requests.get(url, headers=headers, timeout=TIMEOUT,
                                allow_redirects=False, stream=True, verify=True)
        try:
            code = response.status_code
            if code in (301, 302, 303, 307, 308):
                location = response.headers.get('Location')
                try:
                    target = urljoin(url, location or '')
                except ValueError:
                    raise ExchangeRateError('unsupported_page', '환율 페이지의 이동 주소가 올바르지 않아 조회를 중단했습니다.') from None
                if not location or not _same_source_url(target) or redirects >= 3:
                    raise ExchangeRateError('unsupported_page', '공식 금융 도메인 밖 이동 또는 과도한 주소 이동으로 환율 조회를 중단했습니다.')
                url = target
                continue
            if code in (401, 403):
                raise ExchangeRateError('access_denied', f'네이버 금융이 접근을 거절했습니다(HTTP {code}). 우회 조회하지 않습니다.')
            if code != 200:
                raise ExchangeRateError('failed', f'네이버 금융 요청이 성공하지 않았습니다(HTTP {code}).')
            try:
                declared_size = int(response.headers.get('Content-Length', 0))
            except (TypeError, ValueError):
                declared_size = 0
            if declared_size > MAX_BYTES:
                raise ExchangeRateError('failed', '환율 응답이 최대 크기인 2MB를 초과했습니다.')
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ExchangeRateError('failed', '환율 응답이 최대 크기인 2MB를 초과했습니다.')
                chunks.append(chunk)
            return _decode(b''.join(chunks), response.encoding)
        finally:
            response.close()


class _ExchangeTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self._row = None
        self._cell = None
        self._ignored = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._ignored += 1
        if self._ignored:
            return
        if tag == 'tr':
            self._row, self._cell = [], None
        elif tag in ('td', 'th') and self._row is not None:
            if self._cell is not None:
                self._row.append(self._cell)
            self._cell = {'tag': tag, 'classes': set((dict(attrs).get('class') or '').split()), 'text': ''}

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._ignored = max(0, self._ignored - 1)
            return
        if self._ignored:
            return
        if tag in ('td', 'th') and self._cell is not None:
            self._row.append(self._cell)
            self._cell = None
        elif tag == 'tr' and self._row is not None:
            if self._cell is not None:
                self._row.append(self._cell)
            self.rows.append(self._row)
            self._row, self._cell = None, None

    def handle_data(self, data):
        if self._cell is not None and not self._ignored:
            self._cell['text'] += data


def _price(text):
    text = text.strip()
    if len(text) > 40 or not re.fullmatch(r'(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?', text):
        return None
    try:
        value = Decimal(text.replace(',', ''))
    except InvalidOperation:
        return None
    return value if value.is_finite() and 0 < value <= 10**9 else None


def _quoted_units(currency, label):
    suffix = re.search(r'\b' + currency + r'\b(.*)$', label, re.S)
    suffix = suffix.group(1).strip() if suffix else None
    if currency == 'PHP':
        return 1 if suffix == '' or (suffix and re.fullmatch(r'1|\(\s*1\s*\)', suffix)) else None
    # NAVER publishes VND per 100. Require that label explicitly, so a changed
    # unit cannot silently produce a hundredfold conversion error.
    return 100 if suffix and re.fullmatch(r'100|\(\s*100\s*\)', suffix) else None


def _parse_rates(html, observed_at):
    parser = _ExchangeTable()
    parser.feed(html)
    candidates = {currency: [] for currency in CURRENCIES}
    for row in parser.rows:
        title_cells = [cell for cell in row if 'tit' in cell['classes']]
        for currency, country in (('PHP', '필리핀'), ('VND', '베트남')):
            for cell in title_cells or row:
                label = cell['text']
                if country in label and re.search(r'\b' + currency + r'\b', label):
                    candidates[currency].append((label, row))
    rates, errors = {}, []
    for currency in CURRENCIES:
        rows = candidates[currency]
        error = None
        if not rows:
            error = f'{currency} 매매기준율 행을 찾지 못했습니다. 기존 입력 환율을 유지하세요.'
        elif len(rows) != 1:
            error = f'{currency} 환율 행이 중복되어 정확한 값을 선택할 수 없습니다.'
        else:
            label, cells = rows[0]
            sale_cells = [cell for cell in cells if cell['tag'] == 'td' and 'sale' in cell['classes']]
            units = _quoted_units(currency, label)
            quote = _price(sale_cells[0]['text']) if len(sale_cells) == 1 else None
            if units is None:
                error = f'{currency} 고시 단위가 예상 형식과 달라 환율을 적용하지 않았습니다.'
            elif quote is None:
                error = f'{currency} 매매기준율 셀에 유효한 가격이 없습니다. 현찰·송금 환율로 대체하지 않습니다.'
            else:
                rates[currency] = dict(currency=currency, krw_per_unit=float(quote / Decimal(units)),
                    quoted_rate=float(quote), quoted_units=units, observed_at=observed_at,
                    source=SOURCE, source_url=SOURCE_URL, rate_type='매매기준율')
        if error:
            errors.append(dict(currency=currency, error_code='unsupported_page', message=error))
    return rates, errors


def _unavailable(code, message, observed_at):
    return dict(source=SOURCE, source_url=SOURCE_URL, observed_at=observed_at,
        status='unavailable', rates={}, error_code=code, message=message,
        errors=[dict(currency=currency, error_code=code, message=message) for currency in CURRENCIES])


def get_rates():
    """Return verified-format current observations, or an explicit safe failure.

    Cached observations keep their original observation timestamps. After cache
    expiry a fetch failure returns no rates, rather than relabeling stale rates.
    Both successful currencies are independent; one malformed row cannot prevent
    the other valid row from being returned as a partial result.
    """
    now = time.monotonic()
    with _CACHE_LOCK:
        if _CACHE and now < _CACHE['expires_at']:
            return deepcopy(_CACHE['result'])
    try:
        html = _fetch()
        observed_at = _now()
        rates, errors = _parse_rates(html, observed_at)
        status = 'ok' if len(rates) == len(CURRENCIES) else 'partial' if rates else 'unavailable'
        result = dict(source=SOURCE, source_url=SOURCE_URL, observed_at=observed_at,
            status=status, rates=rates, errors=errors,
            message={'ok': '네이버 금융 매매기준율을 조회했습니다.',
                     'partial': '일부 통화만 조회했습니다. 조회되지 않은 통화는 기존 입력값을 유지하세요.',
                     'unavailable': '네이버 금융 환율 형식을 확인하지 못했습니다. 기존 입력 환율을 유지하세요.'}[status])
        if status == 'unavailable':
            result['error_code'] = 'unsupported_page'
    except ExchangeRateError as error:
        result = _unavailable(error.code, error.message, _now())
    except requests.exceptions.ProxyError:
        result = _unavailable('network_blocked', '네이버 금융 연결이 네트워크 프록시에서 차단되었습니다. finance.naver.com 접근 설정을 확인하세요.', _now())
    except requests.exceptions.SSLError:
        result = _unavailable('failed', '네이버 금융 HTTPS 인증서 검증에 실패했습니다. 보안 검증을 끄지 않고 조회를 중단했습니다.', _now())
    except requests.exceptions.Timeout:
        result = _unavailable('failed', '네이버 금융 환율 조회 시간이 초과되었습니다. 기존 입력 환율을 유지하세요.', _now())
    except requests.exceptions.RequestException:
        result = _unavailable('failed', '네이버 금융 환율 조회에 실패했습니다. 기존 입력 환율을 유지하세요.', _now())
    ttl = SUCCESS_TTL if result['rates'] else FAILURE_TTL
    with _CACHE_LOCK:
        _CACHE.clear()
        _CACHE.update(result=deepcopy(result), expires_at=time.monotonic() + ttl)
    return result
