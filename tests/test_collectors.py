"""Synthetic Schema.org fixtures and mocked network tests, not site captures."""

import json
import os
import unittest
from unittest.mock import patch

import requests

import collectors


def fixture(value):
    return '<html><title>Fixture shop</title><script type="application/ld+json">' + json.dumps(value) + '</script></html>'


def product(title='Fixture sunscreen', currency='KRW', price='12000', **overrides):
    return {'@type': 'Product', 'name': title, 'url': '/products/fixture-1',
            'offers': {'@type': 'Offer', 'price': price, 'priceCurrency': currency}, **overrides}


class Response:
    def __init__(self, body='', status=200, headers=None, encoding='utf-8'):
        self.body = body.encode() if isinstance(body, str) else body
        self.status_code, self.headers, self.encoding = status, headers or {}, encoding
        self.closed = False

    def iter_content(self, chunk_size):
        for start in range(0, len(self.body), chunk_size):
            yield self.body[start:start + chunk_size]

    def close(self):
        self.closed = True


@patch.dict(os.environ, {'NAVER_CLIENT_ID': '', 'NAVER_CLIENT_SECRET': ''})
class CollectionTests(unittest.TestCase):
    def setUp(self):
        with collectors._CACHE_LOCK:
            collectors._CACHE.clear()

    @patch('collectors.requests.get')
    def test_standard_itemlist_graph_and_offers_reference(self, get):
        # This is an invented standard fixture; it asserts no real site's HTML shape.
        data = {'@context': 'https://schema.org', '@graph': [
            {'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'item': product(offers={'@id': '#offer'})}]},
            {'@id': '#offer', '@type': 'Offer', 'price': '15000', 'priceCurrency': 'KRW'}]}
        response = Response(fixture(data))
        get.return_value = response
        result = collectors.collect('선크림', ['oliveyoung'])
        self.assertEqual(result['sources'][0]['status'], 'ok')
        row = result['products'][0]
        self.assertEqual((row['title'], row['price'], row['currency'], row['price_kind']), ('Fixture sunscreen', 15000, 'KRW', 'fixed'))
        self.assertIsNone(row['shipping'])
        self.assertEqual(row['url'], 'https://www.oliveyoung.co.kr/products/fixture-1')
        self.assertEqual(result['observed_at'], row['observed_at'])
        self.assertEqual(get.call_args.kwargs['timeout'], (5, 12))
        self.assertTrue(get.call_args.kwargs['verify'])
        self.assertFalse(get.call_args.kwargs['allow_redirects'])
        self.assertTrue(response.closed)

    @patch('collectors.requests.get')
    def test_aggregate_low_price_is_marked_from_and_not_high_price(self, get):
        get.return_value = Response(fixture(product(currency='PHP', offers={
            '@type': 'AggregateOffer', 'lowPrice': '100.50', 'highPrice': '300', 'priceCurrency': 'PHP'})))
        row = collectors.collect('fixture', ['shopee_ph'])['products'][0]
        self.assertEqual((row['price'], row['price_kind'], row['currency']), (100.5, 'from', 'PHP'))

    @patch('collectors.requests.get')
    def test_only_explicit_matching_currency_and_positive_finite_prices(self, get):
        cases = [product(currency='USD'), product(currency=''), product(price='NaN'),
                 product(price='Infinity'), product(price='-100'), product(price=True),
                 product(price='1,000'), product(price=0)]
        for index, value in enumerate(cases):
            with self.subTest(index=index):
                get.return_value = Response(fixture(value))
                result = collectors.collect(f'fixture {index}', ['daiso'])
                self.assertEqual(result['products'], [])
                self.assertEqual(result['sources'][0]['status'], 'unsupported_page')

    @patch('collectors.requests.get')
    def test_proxy_and_site_denial_are_different_and_sanitized(self, get):
        get.side_effect = requests.exceptions.ProxyError('Tunnel connection failed: 403 Forbidden; secret-not-to-print')
        result = collectors.collect('fixture', ['coupang'])
        self.assertEqual(result['sources'][0]['status'], 'network_blocked')
        self.assertNotIn('secret-not-to-print', json.dumps(result))
        get.side_effect = None
        get.return_value = Response(status=403)
        self.assertEqual(collectors.collect('other fixture', ['coupang'])['sources'][0]['status'], 'access_denied')

    @patch('collectors.requests.get')
    def test_rate_limit_auth_and_bad_gateway_status(self, get):
        for code, expected in [(429, 'rate_limited'), (401, 'access_denied'), (502, 'failed')]:
            get.return_value = Response(status=code)
            self.assertEqual(collectors.collect(str(code), ['daiso'])['sources'][0]['status'], expected)

    @patch('collectors.requests.get')
    def test_malformed_dynamic_or_challenge_page_is_not_empty_success(self, get):
        for index, text in enumerate(['<div id="root"></div>', '<script type="application/ld+json">{bad</script>',
                                     '<title>Verify you are human</title>' + fixture(product())]):
            get.return_value = Response(text)
            result = collectors.collect(str(index), ['oliveyoung'])
            self.assertEqual(result['sources'][0]['status'], 'unsupported_page')
            self.assertEqual(result['products'], [])

    @patch('collectors.requests.get')
    def test_explicit_structured_empty_is_distinct_from_unsupported(self, get):
        get.return_value = Response(fixture({'@type': 'ItemList', 'itemListElement': []}))
        result = collectors.collect('fixture', ['oliveyoung'])
        self.assertEqual(result['sources'][0]['status'], 'empty')

    @patch('collectors.requests.get')
    def test_cache_keeps_original_observation_and_does_not_retry_failure(self, get):
        get.return_value = Response(fixture(product()))
        with patch('collectors._now', return_value='2026-01-01T00:00:00+00:00'):
            first = collectors.collect('fixture', ['daiso'])
        first['products'][0]['price'] = 1
        with patch('collectors._now', return_value='2026-01-02T00:00:00+00:00'):
            second = collectors.collect('fixture', ['daiso'])
        self.assertEqual(get.call_count, 1)
        self.assertEqual(second['products'][0]['price'], 12000)
        self.assertEqual(second['observed_at'], '2026-01-01T00:00:00+00:00')
        get.side_effect = requests.exceptions.ProxyError('403')
        collectors.collect('failed', ['daiso'])
        collectors.collect('failed', ['daiso'])
        self.assertEqual(get.call_count, 2)

    @patch('collectors.requests.get')
    def test_expired_cache_retries_only_after_ttl(self, get):
        get.return_value = Response(status=403)
        with patch('collectors.time.monotonic', return_value=100):
            collectors.collect('fixture', ['daiso'])
        with patch('collectors.time.monotonic', return_value=129):
            collectors.collect('fixture', ['daiso'])
        self.assertEqual(get.call_count, 1)
        with patch('collectors.time.monotonic', return_value=131):
            collectors.collect('fixture', ['daiso'])
        self.assertEqual(get.call_count, 2)

    @patch('collectors.requests.get')
    def test_external_downgrade_and_credentials_redirects_not_followed(self, get):
        for index, location in enumerate(['https://evil.example/products', 'http://www.daisomall.co.kr/path',
                                           'https://user:secret@www.daisomall.co.kr/path',
                                           'https://www.daisomall.co.kr:9999/path']):
            get.return_value = Response(status=302, headers={'Location': location})
            before = get.call_count
            result = collectors.collect(str(index), ['daiso'])
            self.assertEqual(result['sources'][0]['status'], 'unsupported_page')
            self.assertEqual(get.call_count - before, 1)

    @patch('collectors.requests.get')
    def test_same_host_redirect_limit_and_allowed_three_redirects(self, get):
        get.side_effect = [Response(status=302, headers={'Location': f'/page{i}'}) for i in range(4)]
        self.assertEqual(collectors.collect('limit', ['daiso'])['sources'][0]['status'], 'unsupported_page')
        self.assertEqual(get.call_count, 4)
        get.reset_mock()
        get.side_effect = [Response(status=302, headers={'Location': f'/page{i}'}) for i in range(3)] + [Response(fixture(product()))]
        self.assertEqual(collectors.collect('allowed', ['daiso'])['sources'][0]['status'], 'ok')
        self.assertEqual(get.call_count, 4)

    @patch('collectors.requests.get')
    def test_declared_and_streamed_response_size_are_bounded(self, get):
        responses = [Response(headers={'Content-Length': str(collectors.MAX_BYTES + 1)}),
                     Response(b'x' * (collectors.MAX_BYTES + 1))]
        for index, response in enumerate(responses):
            get.return_value = response
            self.assertEqual(collectors.collect(str(index), ['daiso'])['sources'][0]['status'], 'failed')
            self.assertTrue(response.closed)

    @patch('collectors.requests.get')
    def test_ids_are_stable_across_price_and_timestamp_changes(self, get):
        get.side_effect = [Response(fixture(product(price='100'))), Response(fixture(product(price='200')))]
        first = collectors.collect('first query', ['daiso'])['products'][0]
        second = collectors.collect('second query', ['daiso'])['products'][0]
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(first['price'], second['price'])

    @patch('collectors.requests.get')
    def test_product_count_and_duplicate_sources_are_bounded(self, get):
        get.return_value = Response(fixture([product(title=f'Fixture {i}', url=f'/product/{i}') for i in range(80)]))
        result = collectors.collect('fixture', ['daiso', 'daiso'])
        self.assertEqual(len(result['products']), 50)
        self.assertEqual(len(result['sources']), 1)
        self.assertEqual(get.call_count, 1)

    @patch('collectors.requests.get')
    def test_invalid_inputs_make_no_network_request(self, get):
        for keyword, sources in [('', None), ('x' * 101, None), (None, None), ('valid', []),
                                 ('valid', ['bad']), ('valid', 'daiso'), ('valid', ['daiso'] * 9)]:
            with self.subTest(keyword=keyword, sources=sources):
                with self.assertRaises(ValueError):
                    collectors.collect(keyword, sources)
        get.assert_not_called()

    @patch('collectors.requests.get')
    def test_tls_and_timeout_errors_do_not_disable_verification(self, get):
        for index, error in enumerate([requests.exceptions.SSLError('cert error'), requests.exceptions.Timeout('timeout')]):
            get.side_effect = error
            result = collectors.collect(str(index), ['daiso'])
            self.assertEqual(result['sources'][0]['status'], 'failed')
            self.assertTrue(get.call_args.kwargs['verify'])

    @patch('collectors.requests.get')
    def test_parallel_sources_keep_declared_order_and_unknown_shipping(self, get):
        def response_for(url, **kwargs):
            currency = 'PHP' if 'shopee.ph' in url else 'KRW'
            return Response(fixture(product(currency=currency)))
        get.side_effect = response_for
        result = collectors.collect('fixture', ['shopee_ph', 'daiso'])
        self.assertEqual([s['source_id'] for s in result['sources']], ['shopee_ph', 'daiso'])
        self.assertEqual([p['currency'] for p in result['products']], ['PHP', 'KRW'])
        self.assertTrue(all(p['shipping'] is None for p in result['products']))

    @patch.dict(os.environ, {'NAVER_CLIENT_ID': 'fixture-client', 'NAVER_CLIENT_SECRET': 'fixture-secret'})
    @patch('collectors.requests.get')
    def test_official_naver_mapping_uses_bound_headers_not_public_scrape(self, get):
        get.return_value = Response(json.dumps({'items': [{'title': '<b>Fixture</b> &amp; sunscreen',
            'lprice': '9000', 'link': 'https://example.com/product'}]}))
        result = collectors.collect('fixture', ['naver'])
        row = result['products'][0]
        self.assertEqual((row['title'], row['price_kind'], row['currency']), ('Fixture & sunscreen', 'from', 'KRW'))
        self.assertTrue(get.call_args.args[0].startswith('https://openapi.naver.com/v1/search/shop.json?'))
        self.assertEqual(get.call_args.kwargs['headers']['X-Naver-Client-Secret'], 'fixture-secret')
        self.assertNotIn('fixture-secret', json.dumps(result))

    @patch.dict(os.environ, {'NAVER_CLIENT_ID': 'fixture-client', 'NAVER_CLIENT_SECRET': 'fixture-secret'})
    @patch('collectors.requests.get')
    def test_naver_malformed_payload_is_not_success(self, get):
        for index, payload in enumerate(['{bad', '{}', '{"items": [{}]}']):
            get.return_value = Response(payload)
            result = collectors.collect(str(index), ['naver'])
            self.assertEqual(result['sources'][0]['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
