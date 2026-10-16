"""API contract tests with synthetic rate data; no live NAVER requests."""

from copy import deepcopy
import os
import unittest
from unittest.mock import patch

from app import app


SOURCE_URL = 'https://finance.naver.com/marketindex/exchangeList.naver'
OBSERVED_AT = '2026-10-16T05:00:00+00:00'


def rate_result():
    rates = {}
    for currency, rate, units in (('PHP', 24.25, 1), ('VND', 5.4, 100)):
        rates[currency] = dict(
            currency=currency, krw_per_unit=rate / units,
            quoted_rate=rate, quoted_units=units, observed_at=OBSERVED_AT,
            source='네이버 금융', source_url=SOURCE_URL, rate_type='매매기준율',
        )
    return dict(source='네이버 금융', source_url=SOURCE_URL,
                observed_at=OBSERVED_AT, status='ok', rates=rates,
                errors=[], message='합성 환율 API 응답입니다.')


class ExchangeRateApiTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_success_preserves_normalized_rates_and_source_metadata(self):
        result = rate_result()
        with patch('app.get_rates', return_value=result) as reader:
            with self.client.get('/api/exchange-rates') as response:
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.is_json)
                self.assertTrue(response.cache_control.no_store)
                self.assertEqual(response.get_json(), result)
                rates = response.get_json()['rates']
                self.assertEqual(rates['PHP']['krw_per_unit'], 24.25)
                self.assertAlmostEqual(rates['VND']['krw_per_unit'], 0.054)
                self.assertEqual(rates['VND']['quoted_units'], 100)
                self.assertEqual(rates['VND']['quoted_rate'], 5.4)
                self.assertEqual(rates['VND']['source_url'], SOURCE_URL)
                self.assertEqual(rates['VND']['observed_at'], OBSERVED_AT)
                self.assertEqual(rates['VND']['rate_type'], '매매기준율')
        reader.assert_called_once_with()

    def test_partial_result_does_not_invent_the_missing_currency(self):
        result = rate_result()
        del result['rates']['VND']
        result['status'] = 'partial'
        result['errors'] = [dict(currency='VND', error_code='unsupported_page',
                                 message='합성 자료에 VND 행이 없습니다.')]
        with patch('app.get_rates', return_value=result) as reader:
            with self.client.get('/api/exchange-rates') as response:
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.cache_control.no_store)
                self.assertEqual(response.get_json(), result)
                self.assertEqual(set(response.get_json()['rates']), {'PHP'})
        reader.assert_called_once_with()

    def test_unavailable_result_has_no_example_or_previous_rate_fallback(self):
        result = rate_result()
        result.update(status='unavailable', rates={}, error_code='network_blocked',
                      errors=[dict(currency=currency, error_code='network_blocked',
                                   message='합성 네트워크 차단 응답입니다.')
                              for currency in ('PHP', 'VND')])
        with patch('app.get_rates', return_value=result) as reader:
            with self.client.get('/api/exchange-rates') as response:
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.is_json)
                self.assertTrue(response.cache_control.no_store)
                self.assertEqual(response.get_json(), result)
                self.assertEqual(response.get_json()['rates'], {})
        reader.assert_called_once_with()

    def test_public_rate_endpoint_and_fx_asset_do_not_expose_credentials(self):
        credentials = {
            'NAVER_CLIENT_ID': 'synthetic-client-id-not-for-public-response',
            'NAVER_CLIENT_SECRET': 'synthetic-client-secret-not-for-public-response',
            'GH_TOKEN': 'synthetic-github-token-not-for-public-response',
        }
        with patch.dict(os.environ, credentials), patch('app.get_rates', return_value=deepcopy(rate_result())):
            for path in ('/api/exchange-rates', '/fx.js'):
                with self.subTest(path=path), self.client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    if path == '/fx.js':
                        self.assertIn(response.mimetype, {'text/javascript', 'application/javascript'})
                        self.assertGreater(len(response.data), 0)
                    else:
                        self.assertTrue(response.is_json)
                    body = response.get_data(as_text=True)
                    for value in credentials.values():
                        self.assertNotIn(value, body)


if __name__ == '__main__':
    unittest.main()
