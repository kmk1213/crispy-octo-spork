"""Synthetic NAVER-shaped table fixtures; not captured or live-verified HTML."""

import json
import unittest
from unittest.mock import patch

import requests

import exchange_rates


def row(currency, sale, *, units=None, cash_buy='999.99', cash_sell='888.88', title_class=True):
    country = {'PHP': '필리핀', 'VND': '베트남'}[currency]
    unit_label = f' {units}' if units is not None else (' 100' if currency == 'VND' else '')
    class_attr = ' class="tit"' if title_class else ''
    return (f'<tr><td{class_attr}><a>{country} {currency}{unit_label}</a></td>'
            f'<td class="sale">{sale}</td><td class="cashbuy">{cash_buy}</td>'
            f'<td class="cashsell">{cash_sell}</td></tr>')


def fixture(*rows):
    return '<!doctype html><meta charset="utf-8"><table><tbody>' + ''.join(rows) + '</tbody></table>'


GOOD = fixture(row('PHP', '26.95'), row('VND', '5.43'))


class Response:
    def __init__(self, body=GOOD, status=200, headers=None, encoding='utf-8'):
        self.body = body.encode() if isinstance(body, str) else body
        self.status_code, self.headers, self.encoding = status, headers or {}, encoding
        self.closed = False

    def iter_content(self, chunk_size):
        for start in range(0, len(self.body), chunk_size):
            yield self.body[start:start + chunk_size]

    def close(self):
        self.closed = True


class ExchangeRateTests(unittest.TestCase):
    def setUp(self):
        with exchange_rates._CACHE_LOCK:
            exchange_rates._CACHE.clear()

    @patch('exchange_rates.requests.get')
    def test_sale_rate_only_and_vnd_100_decimal_normalization(self, get):
        get.return_value = Response()
        result = exchange_rates.get_rates()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['errors'], [])
        php, vnd = result['rates']['PHP'], result['rates']['VND']
        self.assertEqual((php['krw_per_unit'], php['quoted_rate'], php['quoted_units']), (26.95, 26.95, 1))
        self.assertEqual((vnd['krw_per_unit'], vnd['quoted_rate'], vnd['quoted_units']), (0.0543, 5.43, 100))
        self.assertEqual(vnd['rate_type'], '매매기준율')
        self.assertEqual(vnd['source'], '네이버 금융')
        self.assertEqual(vnd['source_url'], exchange_rates.SOURCE_URL)
        self.assertEqual(vnd['observed_at'], result['observed_at'])
        self.assertNotEqual(php['quoted_rate'], 999.99)

    @patch('exchange_rates.requests.get')
    def test_thousands_separator_decimal_and_no_tit_class(self, get):
        get.return_value = Response(fixture(row('PHP', '1,234.56', title_class=False),
                                           row('VND', '\n  5.43\t', title_class=False)))
        rates = exchange_rates.get_rates()['rates']
        self.assertEqual(rates['PHP']['krw_per_unit'], 1234.56)
        self.assertEqual(rates['VND']['krw_per_unit'], 0.0543)

    @patch('exchange_rates.requests.get')
    def test_missing_currency_returns_partial_and_preserves_valid_currency(self, get):
        get.return_value = Response(fixture(row('VND', '5.43')))
        result = exchange_rates.get_rates()
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(set(result['rates']), {'VND'})
        self.assertEqual(result['errors'][0]['currency'], 'PHP')

    @patch('exchange_rates.requests.get')
    def test_duplicate_rows_are_rejected_even_if_quotes_match(self, get):
        get.return_value = Response(fixture(row('PHP', '26.95'), row('PHP', '26.95'), row('VND', '5.43')))
        result = exchange_rates.get_rates()
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(set(result['rates']), {'VND'})
        self.assertIn('중복', result['errors'][0]['message'])

    @patch('exchange_rates.requests.get')
    def test_invalid_prices_do_not_fall_back_to_cash_quotes(self, get):
        for sale in ('', '0', '-5', 'NaN', 'Infinity', '12,34.00', '1e2', '+10', '100 원'):
            with self.subTest(sale=sale):
                exchange_rates._CACHE.clear()
                get.return_value = Response(fixture(row('PHP', sale), row('VND', '5.43')))
                result = exchange_rates.get_rates()
                self.assertEqual(set(result['rates']), {'VND'})
                self.assertEqual(result['status'], 'partial')

    @patch('exchange_rates.requests.get')
    def test_missing_or_duplicate_sale_cell_not_substituted(self, get):
        for bad_row in (row('PHP', '26.95').replace('class="sale"', 'class="cashbuy"'),
                        row('PHP', '26.95').replace('</tr>', '<td class="sale">26.95</td></tr>'),
                        row('PHP', '26.95').replace('<td class="sale">26.95</td>', '<th class="sale">26.95</th>')):
            exchange_rates._CACHE.clear()
            get.return_value = Response(fixture(bad_row, row('VND', '5.43')))
            result = exchange_rates.get_rates()
            self.assertEqual(set(result['rates']), {'VND'})

    @patch('exchange_rates.requests.get')
    def test_vnd_unit_must_explicitly_be_100(self, get):
        for units in ('1', '1000', '', '100.5', '100e2'):
            exchange_rates._CACHE.clear()
            get.return_value = Response(fixture(row('PHP', '26.95'), row('VND', '5.43', units=units)))
            result = exchange_rates.get_rates()
            self.assertEqual(set(result['rates']), {'PHP'})
            self.assertIn('단위', result['errors'][0]['message'])

    @patch('exchange_rates.requests.get')
    def test_scripts_cannot_supply_fake_rates(self, get):
        get.return_value = Response('<script>' + GOOD + '</script><main>동적 페이지</main>')
        result = exchange_rates.get_rates()
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['rates'], {})
        self.assertEqual(result['error_code'], 'unsupported_page')

    @patch('exchange_rates.requests.get')
    def test_cached_success_preserves_timestamp_and_is_defensive_copy(self, get):
        get.return_value = Response()
        with patch('exchange_rates.time.monotonic', return_value=100), patch('exchange_rates._now', return_value='original-time'):
            first = exchange_rates.get_rates()
        first['rates']['VND']['krw_per_unit'] = 999
        with patch('exchange_rates.time.monotonic', return_value=699), patch('exchange_rates._now', return_value='later-time'):
            second = exchange_rates.get_rates()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(second['observed_at'], 'original-time')
        self.assertEqual(second['rates']['VND']['observed_at'], 'original-time')
        self.assertEqual(second['rates']['VND']['krw_per_unit'], 0.0543)

    @patch('exchange_rates.requests.get')
    def test_expired_success_not_returned_on_failure_and_failure_cached_30_seconds(self, get):
        get.return_value = Response()
        with patch('exchange_rates.time.monotonic', return_value=100):
            exchange_rates.get_rates()
        get.side_effect = requests.exceptions.ProxyError('403 PRIVATE_PROXY_CREDENTIAL')
        with patch('exchange_rates.time.monotonic', return_value=701), patch('exchange_rates._now', return_value='failure-time'):
            failed = exchange_rates.get_rates()
        self.assertEqual(failed['rates'], {})
        self.assertEqual(failed['status'], 'unavailable')
        self.assertEqual(failed['error_code'], 'network_blocked')
        with patch('exchange_rates.time.monotonic', return_value=730):
            cached = exchange_rates.get_rates()
        self.assertEqual(get.call_count, 2)
        self.assertEqual(cached['observed_at'], 'failure-time')
        with patch('exchange_rates.time.monotonic', return_value=731):
            exchange_rates.get_rates()
        self.assertEqual(get.call_count, 3)

    @patch('exchange_rates.requests.get')
    def test_partial_success_is_cached_for_10_minutes(self, get):
        get.return_value = Response(fixture(row('PHP', '26.95')))
        with patch('exchange_rates.time.monotonic', return_value=100):
            exchange_rates.get_rates()
        with patch('exchange_rates.time.monotonic', return_value=699):
            self.assertEqual(exchange_rates.get_rates()['status'], 'partial')
        self.assertEqual(get.call_count, 1)

    @patch('exchange_rates.requests.get')
    def test_request_has_verified_tls_bounded_timeout_and_default_proxy_configuration(self, get):
        response = Response()
        get.return_value = response
        exchange_rates.get_rates()
        self.assertEqual(get.call_args.args, (exchange_rates.SOURCE_URL,))
        self.assertIs(get.call_args.kwargs['verify'], True)
        self.assertIs(get.call_args.kwargs['allow_redirects'], False)
        self.assertIs(get.call_args.kwargs['stream'], True)
        self.assertEqual(get.call_args.kwargs['timeout'], (5, 12))
        self.assertNotIn('proxies', get.call_args.kwargs)
        self.assertTrue(response.closed)

    @patch('exchange_rates.requests.get')
    def test_exceptions_are_classified_without_raw_credentials_or_details(self, get):
        cases = [(requests.exceptions.ProxyError, 'network_blocked'),
                 (requests.exceptions.SSLError, 'failed'),
                 (requests.exceptions.Timeout, 'failed'),
                 (requests.exceptions.ConnectionError, 'failed')]
        for error_type, code in cases:
            exchange_rates._CACHE.clear()
            get.side_effect = error_type('PRIVATE_TOKEN username:password')
            result = exchange_rates.get_rates()
            self.assertEqual(result['error_code'], code)
            self.assertEqual(result['rates'], {})
            self.assertNotIn('PRIVATE_TOKEN', json.dumps(result))
            self.assertNotIn('username:password', json.dumps(result))

    @patch('exchange_rates.requests.get')
    def test_http_denial_and_server_failures_are_explicit(self, get):
        for status, code in ((401, 'access_denied'), (403, 'access_denied'), (429, 'failed'), (502, 'failed')):
            exchange_rates._CACHE.clear()
            response = Response(status=status)
            get.return_value = response
            result = exchange_rates.get_rates()
            self.assertEqual(result['error_code'], code)
            self.assertTrue(response.closed)

    @patch('exchange_rates.requests.get')
    def test_external_insecure_or_credentialed_redirects_rejected(self, get):
        for location in ('https://evil.example/quotes', 'http://finance.naver.com/quotes',
                         'https://user:secret@finance.naver.com/quotes',
                         'https://finance.naver.com:8443/quotes', '//elsewhere.naver.com/quotes',
                         'https://[broken'):
            exchange_rates._CACHE.clear()
            response = Response(status=302, headers={'Location': location})
            get.return_value = response
            before = get.call_count
            result = exchange_rates.get_rates()
            self.assertEqual(result['error_code'], 'unsupported_page')
            self.assertEqual(get.call_count, before + 1)
            self.assertTrue(response.closed)

    @patch('exchange_rates.requests.get')
    def test_same_host_redirects_bounded_and_accepted(self, get):
        get.side_effect = [Response(status=302, headers={'Location': '/next'}) for _ in range(4)]
        self.assertEqual(exchange_rates.get_rates()['error_code'], 'unsupported_page')
        self.assertEqual(get.call_count, 4)
        exchange_rates._CACHE.clear()
        get.reset_mock()
        get.side_effect = [Response(status=302, headers={'Location': '/next'}) for _ in range(3)] + [Response()]
        self.assertEqual(exchange_rates.get_rates()['status'], 'ok')
        self.assertEqual(get.call_count, 4)

    @patch('exchange_rates.requests.get')
    def test_declared_and_streamed_oversized_responses_are_closed_and_rejected(self, get):
        for response in (Response(headers={'Content-Length': str(exchange_rates.MAX_BYTES + 1)}),
                         Response(body=b'x' * (exchange_rates.MAX_BYTES + 1))):
            exchange_rates._CACHE.clear()
            get.return_value = response
            result = exchange_rates.get_rates()
            self.assertEqual(result['error_code'], 'failed')
            self.assertEqual(result['rates'], {})
            self.assertTrue(response.closed)

    @patch('exchange_rates.requests.get')
    def test_euc_kr_meta_encoding_supported_when_http_encoding_unspecified(self, get):
        body = GOOD.replace('charset="utf-8"', 'charset="euc-kr"').encode('euc-kr')
        get.return_value = Response(body=body, encoding='ISO-8859-1')
        self.assertEqual(exchange_rates.get_rates()['status'], 'ok')


if __name__ == '__main__':
    unittest.main()
