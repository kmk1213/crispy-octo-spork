"""Bounded, ordinary public-page collection; no login or access-control bypass.

HTML support is limited to the published Schema.org JSON-LD standard. No live
site-specific selectors have been verified in this environment. The tests use
synthetic standards fixtures, not captured marketplace responses.
"""

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from html import unescape
from html.parser import HTMLParser
import json
import os
import re
from threading import Lock
import time
from urllib.parse import urlencode, urljoin, urlsplit

import requests


SOURCES = {
    'oliveyoung': dict(source='올리브영', country='한국', currency='KRW',
        search='https://www.oliveyoung.co.kr/store/search/getSearchMain.do?query='),
    'daiso': dict(source='다이소', country='한국', currency='KRW',
        search='https://www.daisomall.co.kr/ds/search/totalSearch?searchTerm='),
    'coupang': dict(source='쿠팡', country='한국', currency='KRW',
        search='https://www.coupang.com/np/search?q='),
    'naver': dict(source='네이버쇼핑', country='한국', currency='KRW',
        search='https://search.shopping.naver.com/search/all?query='),
    'shopee_ph': dict(source='Shopee 필리핀', country='필리핀', currency='PHP',
        search='https://shopee.ph/search?keyword='),
    'shopee_vn': dict(source='Shopee 베트남', country='베트남', currency='VND',
        search='https://shopee.vn/search?keyword='),
    'lazada_ph': dict(source='Lazada 필리핀', country='필리핀', currency='PHP',
        search='https://www.lazada.com.ph/catalog/?q='),
    'lazada_vn': dict(source='Lazada 베트남', country='베트남', currency='VND',
        search='https://www.lazada.vn/catalog/?q='),
}
MAX_BYTES = 2 * 1024 * 1024
MAX_PRODUCTS = 50
TIMEOUT = (5, 12)
SUCCESS_TTL = 600
FAILURE_TTL = 30
_CACHE = OrderedDict()
_CACHE_LOCK = Lock()


class CollectionError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def search_url(source_id, keyword):
    return SOURCES[source_id]['search'] + urlencode({'q': keyword})[2:]


def _safe_url(value, base=''):
    if not isinstance(value, str) or len(value) > 4000:
        return ''
    try:
        value = urljoin(base, value)
        parsed = urlsplit(value)
        if parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return ''


def _fetch(url, headers=None):
    """Fetch only a caller-owned fixed URL, retaining TLS and proxy defaults."""
    original = urlsplit(url)
    request_headers = {'User-Agent': 'SourcingRadar/1.0 (public product metadata collector)',
                       'Accept': 'text/html,application/ld+json,application/json;q=0.9'}
    request_headers.update(headers or {})
    for redirects in range(4):
        response = requests.get(url, headers=request_headers, timeout=TIMEOUT,
                                allow_redirects=False, stream=True, verify=True)
        try:
            code = response.status_code
            if code in (301, 302, 303, 307, 308):
                target = urljoin(url, response.headers.get('Location', ''))
                try:
                    parsed = urlsplit(target)
                    allowed = (parsed.scheme == 'https' and parsed.hostname == original.hostname
                               and parsed.port in (None, 443) and not parsed.username and not parsed.password)
                except ValueError:
                    allowed = False
                if not response.headers.get('Location') or not allowed or redirects >= 3:
                    raise CollectionError('unsupported_page', '외부·비보안 주소 이동 또는 과도한 주소 이동으로 수집을 중단했습니다.')
                url = target
                continue
            if code == 429:
                raise CollectionError('rate_limited', '사이트가 요청 한도를 반환했습니다(HTTP 429). 잠시 후 다시 확인하세요.')
            if code in (401, 403):
                raise CollectionError('access_denied', f'사이트가 접근을 거절했습니다(HTTP {code}). 우회 수집하지 않습니다.')
            if code != 200:
                raise CollectionError('failed', f'사이트 요청이 성공하지 않았습니다(HTTP {code}).')
            try:
                declared_size = int(response.headers.get('Content-Length', 0))
            except (ValueError, TypeError):
                declared_size = 0
            if declared_size > MAX_BYTES:
                raise CollectionError('failed', '응답이 수집 제한인 2MB를 초과했습니다.')
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise CollectionError('failed', '응답이 수집 제한인 2MB를 초과했습니다.')
                chunks.append(chunk)
            encoding = response.encoding
            if not encoding or encoding.lower() in ('iso-8859-1', 'ascii'):
                encoding = 'utf-8'
            try:
                text = b''.join(chunks).decode(encoding, errors='replace')
            except LookupError:
                text = b''.join(chunks).decode('utf-8', errors='replace')
            return text, url
        finally:
            response.close()


class _JSONLD(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts, self.title = [], ''
        self._script, self._title = None, False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and str(attrs.get('type', '')).split(';')[0].strip().lower() == 'application/ld+json':
            self._script = []
        if tag == 'title':
            self._title = True

    def handle_endtag(self, tag):
        if tag == 'script' and self._script is not None:
            self.scripts.append(''.join(self._script))
            self._script = None
        if tag == 'title':
            self._title = False

    def handle_data(self, data):
        if self._script is not None:
            self._script.append(data)
        if self._title:
            self.title += data


def _has_type(node, name):
    types = node.get('@type', [])
    types = types if isinstance(types, list) else [types]
    return any(isinstance(t, str) and t.rstrip('/').rsplit('/', 1)[-1].rsplit('#', 1)[-1] == name for t in types)


def _walk(value, depth=0):
    if depth > 30:
        return
    if isinstance(value, dict):
        yield value
        for child in value.values():
            if isinstance(child, (dict, list)):
                yield from _walk(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child, depth + 1)


def _price(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite() or amount <= 0 or amount > 10**12:
        return None
    return float(amount)


def _record(source_id, title, price, currency, url, kind, observed_at):
    source = SOURCES[source_id]
    stable = json.dumps([source_id, url, title, kind], ensure_ascii=False, separators=(',', ':'))
    return dict(id=sha256(stable.encode()).hexdigest()[:24], title=title, source_id=source_id,
                source=source['source'], country=source['country'], currency=currency,
                price=price, price_kind=kind, shipping=None, url=url, observed_at=observed_at)


def _parse_jsonld(text, source_id, page_url, observed_at):
    parser = _JSONLD()
    parser.feed(text)
    if re.search(r'captcha|verify (?:that )?you are human|access denied|robot check|just a moment', parser.title, re.I):
        raise CollectionError('unsupported_page', '인증·자동 접근 확인 화면이 표시되어 수집을 중단했습니다.')
    documents = []
    for script in parser.scripts:
        try:
            documents.append(json.loads(script))
        except (ValueError, RecursionError):
            continue
    nodes = [node for document in documents for node in _walk(document)]
    references = {node['@id']: node for node in nodes if isinstance(node.get('@id'), str) and len(node) > 1}

    def dereference(node):
        if isinstance(node, dict) and len(node) == 1 and isinstance(node.get('@id'), str):
            return references.get(node['@id'], node)
        return node

    products, seen = [], set()
    explicit_empty = False
    for node in nodes:
        if _has_type(node, 'ItemList'):
            items = node.get('itemListElement')
            count = node.get('numberOfItems')
            if items == [] or (items is None and not isinstance(count, bool) and count in (0, '0')):
                explicit_empty = True
        if not _has_type(node, 'Product'):
            continue
        title = node.get('name')
        if not isinstance(title, str) or not title.strip():
            continue
        title = unescape(title.strip())[:500]
        offers = node.get('offers', [])
        offers = offers if isinstance(offers, list) else [offers]
        for raw_offer in offers:
            offer = dereference(raw_offer)
            if not isinstance(offer, dict):
                continue
            currency = offer.get('priceCurrency')
            # Never infer currency from the hostname or interpret an unlabelled number.
            if not isinstance(currency, str) or currency.upper() != SOURCES[source_id]['currency']:
                continue
            currency = currency.upper()
            aggregate = _has_type(offer, 'AggregateOffer')
            kind = 'from' if aggregate else 'fixed'
            price = _price(offer.get('lowPrice') if aggregate else offer.get('price'))
            if price is None:
                continue
            url = _safe_url(offer.get('url') or node.get('url') or node.get('@id'), page_url)
            if not url:
                continue
            record = _record(source_id, title, price, currency, url, kind, observed_at)
            if record['id'] not in seen:
                products.append(record)
                seen.add(record['id'])
            if len(products) >= MAX_PRODUCTS:
                return products
    if products or explicit_empty:
        return products
    raise CollectionError('unsupported_page', '공개 페이지에서 지원하는 상품 JSON-LD와 명시된 현지 통화 가격을 찾지 못했습니다. 자바스크립트·인증 화면은 자동 처리하지 않습니다.')


def _naver(keyword, observed_at, client, secret):
    url = 'https://openapi.naver.com/v1/search/shop.json?' + urlencode(dict(query=keyword, display=50, sort='asc'))
    text, _ = _fetch(url, headers={'X-Naver-Client-Id': client, 'X-Naver-Client-Secret': secret})
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        raise CollectionError('failed', '네이버 API 응답이 올바른 JSON이 아닙니다.')
    if not isinstance(data, dict) or not isinstance(data.get('items'), list):
        raise CollectionError('failed', '네이버 API 상품 목록 형식이 올바르지 않습니다.')
    products, seen = [], set()
    for item in data['items'][:MAX_PRODUCTS]:
        if not isinstance(item, dict):
            continue
        title, url = item.get('title'), _safe_url(item.get('link'))
        price = _price(item.get('lprice'))
        if not isinstance(title, str) or not title.strip() or not url or price is None:
            continue
        title = unescape(re.sub('<[^>]*>', '', title)).strip()[:500]
        if not title:
            continue
        record = _record('naver', title, price, 'KRW', url, 'from', observed_at)
        if record['id'] not in seen:
            products.append(record)
            seen.add(record['id'])
    if data['items'] and not products:
        raise CollectionError('failed', '네이버 API 응답에 유효한 상품명·가격·주소가 없습니다.')
    return products


def _collect_source(source_id, keyword):
    client, secret = os.getenv('NAVER_CLIENT_ID'), os.getenv('NAVER_CLIENT_SECRET')
    use_api = source_id == 'naver' and bool(client and secret)
    key = (source_id, keyword, use_api)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            _CACHE.move_to_end(key)
            return deepcopy(cached[1])
    observed_at = _now()
    state = dict(source_id=source_id, source=SOURCES[source_id]['source'], count=0,
                 observed_at=observed_at)
    products = []
    try:
        if use_api:
            products = _naver(keyword, observed_at, client, secret)
        else:
            text, page_url = _fetch(search_url(source_id, keyword))
            products = _parse_jsonld(text, source_id, page_url, observed_at)
        state.update(status='ok' if products else 'empty', count=len(products),
            message=('공식 네이버 검색 API 표시 최저가입니다. 옵션·배송료를 확인하세요.' if use_api else
                     '공개 JSON-LD 표시 가격입니다. 옵션·배송료와 동일 상품 여부를 확인하세요.') if products else
                     '유효한 구조화 상품 목록이 비어 있습니다.')
    except CollectionError as error:
        state.update(status=error.status, message=error.message)
    except requests.exceptions.ProxyError:
        state.update(status='network_blocked', message='네트워크 프록시 연결이 거절되었습니다. 허용 도메인·프록시 설정을 확인하세요. 사이트 응답은 확인하지 못했습니다.')
    except requests.exceptions.SSLError:
        state.update(status='failed', message='TLS 인증서 검증에 실패했습니다. 검증을 해제하지 않고 수집을 중단했습니다.')
    except requests.exceptions.Timeout:
        state.update(status='failed', message='사이트 연결 또는 응답 시간이 초과되었습니다.')
    except requests.exceptions.RequestException:
        state.update(status='failed', message='사이트 네트워크 요청에 실패했습니다. 연결 상태를 확인하세요.')
    except (ValueError, TypeError, RecursionError):
        state.update(status='failed', message='사이트 응답을 안전하게 해석하지 못했습니다.')
    result = (products, state)
    ttl = SUCCESS_TTL if state['status'] in ('ok', 'empty') else FAILURE_TTL
    with _CACHE_LOCK:
        _CACHE[key] = (time.monotonic() + ttl, deepcopy(result))
        _CACHE.move_to_end(key)
        while len(_CACHE) > 256:
            _CACHE.popitem(last=False)
    return result


def collect(keyword, sources=None):
    """Return observed prices and honest per-source status; never invent prices."""
    if not isinstance(keyword, str) or not keyword.strip() or len(keyword.strip()) > 100:
        raise ValueError('검색어는 1~100자로 입력하세요.')
    keyword = keyword.strip()
    if sources is None:
        source_ids = list(SOURCES)
    else:
        if (not isinstance(sources, list) or not sources or len(sources) > 8
                or any(not isinstance(s, str) or s not in SOURCES for s in sources)):
            raise ValueError('수집 대상은 지원하는 사이트 ID 1~8개로 지정하세요.')
        source_ids = list(dict.fromkeys(sources))
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda source_id: _collect_source(source_id, keyword), source_ids))
    products = [product for items, _ in results for product in items]
    states = [state for _, state in results]
    return dict(query=keyword, observed_at=max(state['observed_at'] for state in states),
                products=products, sources=states,
                message=f'{len(states)}개 사이트 중 {sum(s["status"] == "ok" for s in states)}개에서 {len(products)}건을 수집했습니다. 배송료 미확인·옵션별 가격이며 판매량이나 수익을 보장하지 않습니다.')
