"""Install local dependencies and open the app on the user's own computer."""
import http.client
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import venv
import webbrowser


def main():
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10 이상을 설치한 뒤 다시 실행하세요.')
    root = Path(__file__).resolve().parent
    executable = root / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not executable.is_file():
        print('처음 실행: Python 실행 환경을 준비합니다.', flush=True)
        venv.EnvBuilder(with_pip=True).create(root / '.venv')
    subprocess.run([str(executable), '-m', 'pip', 'install', '-r', str(root / 'requirements.txt')], check=True)
    # Pick an unused local port so an unrelated server on 8000 cannot open instead.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    environment = {**os.environ, 'PORT': str(port)}
    process = subprocess.Popen([str(executable), '-u', str(root / 'app.py')], cwd=root, env=environment)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('서버 시작에 실패했습니다. 위의 오류 내용을 확인하세요.')
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
            try:
                connection.request('GET', '/')
                response = connection.getresponse()
                if response.status == 200 and '사입 레이더'.encode() in response.read():
                    break
            except OSError:
                pass
            finally:
                connection.close()
            time.sleep(.2)
        else:
            raise RuntimeError('서버가 30초 안에 준비되지 않았습니다. 위의 오류 내용을 확인하세요.')
        print('준비 완료. 이 창을 열어 두세요. 종료하려면 Ctrl+C를 누르세요.', flush=True)
        # This runs on the user's PC; it does not expose a cloud preview or public server.
        if environment.get('SOURCING_NO_BROWSER') != '1':
            webbrowser.open(f'http://127.0.0.1:{port}/')
        process.wait()
        return process.returncode
    except KeyboardInterrupt:
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'실행 실패: {error}', file=sys.stderr)
        sys.exit(1)
