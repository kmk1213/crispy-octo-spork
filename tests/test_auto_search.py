"""Same-origin collection endpoints and browser-site delivery contracts.

The collector is mocked throughout: route checks never contact shopping sites,
consume API quota, or assert that sample fixtures are current live prices.
"""

import copy
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import threading
import unittest
from unittest.mock import patch

from app import app


OBSERVED_AT = '2026-10-16T03:04:05+00:00'


def result_payload():
    return {
        'query': '선크림',
        'observed_at': OBSERVED_AT,
        'products': [{
            'title': '테스트 상품 선크림 50ml',
            'price': 15900,
            'currency': 'KRW',
            'source': 'naver',
            'url': 'https://example.com/product/fixture',
            'observed_at': OBSERVED_AT,
            'shipping': None,
        }],
        'sources': [{'source': 'naver', 'status': 'ok', 'count': 1}],
        'message': '수집된 표시 가격입니다. 옵션과 배송 조건을 확인하세요.',
    }


def collected_arguments(mock):
    """Permit an ordinary positional or keyword-only collect interface."""
    args, kwargs = mock.call_args
    query = kwargs.get('query', args[0] if args else None)
    sources = kwargs.get('sources', args[1] if len(args) > 1 else None)
    return query, sources


class AutoSearchRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_collected_product_values_and_observation_time_survive_response(self):
        payload = result_payload()
        with patch('app.collect', return_value=payload) as collector:
            response = self.client.get('/api/collect', query_string={
                'q': '선크림', 'sources': 'naver',
            })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.is_json)
        self.assertEqual(response.json, payload)
        self.assertEqual(response.json['products'][0]['price'], 15900)
        self.assertEqual(response.json['products'][0]['currency'], 'KRW')
        self.assertEqual(response.json['products'][0]['observed_at'], OBSERVED_AT)
        self.assertIsNone(response.json['products'][0]['shipping'],
                          'unknown shipping must not become a fabricated zero')
        self.assertIn('no-store', response.headers.get('Cache-Control', ''))
        self.assertEqual(collected_arguments(collector), ('선크림', ['naver']))

    def test_partial_and_blocked_sources_are_reported_without_fake_success(self):
        payload = result_payload()
        payload['sources'].append({
            'source': 'oliveyoung', 'status': 'blocked', 'count': 0,
            'message': '접근이 차단되어 가격을 수집하지 못했습니다.',
        })
        payload['message'] = '네이버만 수집했습니다. 올리브영은 접근 차단 상태입니다.'
        with patch('app.collect', return_value=payload):
            response = self.client.get('/api/collect', query_string={
                'q': '선크림', 'sources': 'oliveyoung,naver',
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, payload)
        blocked = response.json['sources'][1]
        self.assertEqual(blocked['status'], 'blocked')
        self.assertEqual(blocked['count'], 0)
        self.assertEqual(len(response.json['products']), 1)
        self.assertNotIn('oliveyoung', [row['source'] for row in response.json['products']])

    def test_comma_separated_and_repeated_source_parameters_are_parsed(self):
        cases = [
            ([('sources', 'oliveyoung,naver')], ['oliveyoung', 'naver']),
            ([('sources', 'oliveyoung'), ('sources', 'naver')], ['oliveyoung', 'naver']),
            ([('sources', 'oliveyoung,naver'), ('sources', 'daiso')],
             ['oliveyoung', 'naver', 'daiso']),
        ]
        for parameters, expected in cases:
            with self.subTest(parameters=parameters):
                with patch('app.collect', return_value=result_payload()) as collector:
                    response = self.client.get('/api/collect', query_string=[
                        ('q', '선크림'), *parameters,
                    ])
                self.assertEqual(response.status_code, 200)
                self.assertEqual(collected_arguments(collector), ('선크림', expected))

    def test_empty_query_and_unsupported_sources_return_readable_validation_errors(self):
        cases = [
            ({'q': '', 'sources': 'naver'}, '검색어를 입력하세요.'),
            ({'q': '선크림', 'sources': 'unknown'}, '지원하지 않는 수집처입니다: unknown'),
        ]
        for parameters, error in cases:
            with self.subTest(parameters=parameters):
                with patch('app.collect', side_effect=ValueError(error)) as collector:
                    response = self.client.get('/api/collect', query_string=parameters)
                self.assertEqual(response.status_code, 400)
                self.assertTrue(response.is_json)
                self.assertEqual(response.json, {'error': error})
                collector.assert_called_once()

    def test_validation_failures_do_not_consume_collection_slots(self):
        with patch('app.collect', side_effect=ValueError('검색어를 입력하세요.')):
            for _ in range(3):
                response = self.client.get('/api/collect', query_string={'q': ''})
                self.assertEqual(response.status_code, 400)
        with patch('app.collect', return_value=result_payload()):
            response = self.client.get('/api/collect', query_string={'q': '선크림'})
        self.assertEqual(response.status_code, 200)

    def test_only_two_collectors_run_at_once_and_released_capacity_is_reusable(self):
        release = threading.Event()
        two_entered = threading.Event()
        lock = threading.Lock()
        entered = 0

        def slow_collect(*args, **kwargs):
            nonlocal entered
            with lock:
                entered += 1
                if entered == 2:
                    two_entered.set()
            if not release.wait(5):
                raise RuntimeError('test collector release timed out')
            return copy.deepcopy(result_payload())

        def request_collection():
            with app.test_client() as client:
                return client.get('/api/collect', query_string={'q': '선크림'})

        with patch('app.collect', side_effect=slow_collect) as collector:
            with ThreadPoolExecutor(max_workers=2) as executor:
                requests = [executor.submit(request_collection) for _ in range(2)]
                try:
                    self.assertTrue(two_entered.wait(3), 'both allowed requests must reach collect')
                    busy = self.client.get('/api/collect', query_string={'q': '선크림'})
                    self.assertEqual(busy.status_code, 429)
                    self.assertTrue(busy.is_json)
                    self.assertTrue(busy.json.get('error'))
                    self.assertEqual(collector.call_count, 2,
                                     'a busy response must not start a third collector')
                finally:
                    release.set()
                self.assertEqual([future.result(timeout=3).status_code for future in requests],
                                 [200, 200])
            later = self.client.get('/api/collect', query_string={'q': '선크림'})
            self.assertEqual(later.status_code, 200)

    def test_health_is_available_without_a_shopping_request(self):
        with patch('app.collect') as collector:
            response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.is_json)
        self.assertEqual(response.json['status'], 'ok')
        collector.assert_not_called()

    def test_home_serves_the_browser_site_and_same_origin_assets(self):
        with self.client.get('/') as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'text/html')
            self.assertIn('MK커뮤니케이션', response.get_data(as_text=True))
            self.assertIn('site.js', response.get_data(as_text=True))
            self.assertIn('config.js', response.get_data(as_text=True))
        assets = {
            '/core.js': {'text/javascript', 'application/javascript'},
            '/site.js': {'text/javascript', 'application/javascript'},
            '/xlsx.js': {'text/javascript', 'application/javascript'},
            '/styles.css': {'text/css'},
            '/assets/mk-logo.png': {'image/png'},
        }
        for path, mimetypes in assets.items():
            with self.subTest(path=path):
                with self.client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertIn(response.mimetype, mimetypes)
                    self.assertGreater(len(response.data), 0)
                    if path.endswith('.png'):
                        self.assertTrue(response.data.startswith(b'\x89PNG\r\n\x1a\n'))

    def test_config_enables_same_origin_backend_without_exposing_credentials(self):
        fake_secret = 'test-only-do-not-embed-naver-secret'
        fake_client = 'test-only-do-not-embed-naver-client'
        with patch.dict(os.environ, {
            'NAVER_CLIENT_SECRET': fake_secret,
            'NAVER_CLIENT_ID': fake_client,
        }):
            response = self.client.get('/config.js')
        self.assertEqual(response.status_code, 200)
        self.assertIn(response.mimetype, {'text/javascript', 'application/javascript'})
        body = response.get_data(as_text=True)
        self.assertIn('window.SOURCING_BACKEND', body)
        self.assertRegex(body, r'''["']?available["']?\s*:\s*true''')
        self.assertNotIn(fake_secret, body)
        self.assertNotIn(fake_client, body)
        self.assertNotIn('NAVER_CLIENT_SECRET', body)
        self.assertNotIn('NAVER_CLIENT_ID', body)

    def test_static_site_config_marks_the_backend_unavailable(self):
        static_config = Path(__file__).resolve().parents[1] / 'web' / 'config.js'
        body = static_config.read_text(encoding='utf-8')
        self.assertIn('window.SOURCING_BACKEND', body)
        self.assertRegex(body, r'''["']?available["']?\s*:\s*false''')
        self.assertNotRegex(body, re.compile('NAVER_CLIENT_(?:ID|SECRET)'))


if __name__ == '__main__':
    unittest.main()
