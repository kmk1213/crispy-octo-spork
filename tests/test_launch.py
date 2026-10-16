import io
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
import webbrowser

from launch import open_browser


class BrowserLaunchTests(unittest.TestCase):
    def test_success_prints_manual_address(self):
        with patch('launch.webbrowser.open', return_value=True) as opened, redirect_stdout(io.StringIO()) as out:
            open_browser(12345)
        opened.assert_called_once_with('http://127.0.0.1:12345/')
        self.assertIn('http://127.0.0.1:12345/', out.getvalue())

    def test_missing_browser_keeps_manual_fallback(self):
        for result in [False, webbrowser.Error('No browser'), OSError('Unavailable')]:
            with self.subTest(result=result):
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                with patch('launch.webbrowser.open', **kwargs), redirect_stdout(io.StringIO()) as out:
                    open_browser(12345)
                self.assertIn('서버는 실행 중', out.getvalue())
                self.assertIn('http://127.0.0.1:12345/', out.getvalue())
