# serve.py — 双端口静态服务器（8010 HTTP + 8443 HTTPS）
# 缓存策略（v2.23.3）：Cache-Control: no-cache（允许浏览器存储，但每次使用前必须重验证）
#   + 强 ETag（size + mtime_ns）协商缓存：
#   - 文件未变 → 304 Not Modified（~几百字节），浏览器直接用本地缓存的 GLB/贴图，不再全量重下
#   - 文件已变 → ETag 失配 → 200 全量新内容，普通刷新即可拿到新版（无需强制刷新）
#   用 mtime_ns（纳秒）做校验器，避开 Last-Modified 秒级精度"同秒修改 304 命中旧缓存体"的坑。
import functools
import http.server
import os
import ssl
import threading

os.chdir(os.path.dirname(os.path.abspath(__file__)))


def _etag(path):
    st = os.stat(path)
    return f'"{st.st_size:x}-{st.st_mtime_ns:x}"'


class RevalidateHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 允许存储 + 每次使用前重验证；带 ETag 让重验证命中时回 304 零下载
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            try:
                self.send_header('ETag', _etag(path))
            except OSError:
                pass
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    # 兼容保险：继续屏蔽秒级精度的 If-Modified-Since（我们发的是强 ETag，
    # If-None-Match 优先级更高；防止客户端带着旧 Last-Modified 走误判路径）。
    def _strip_conditional(self):
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']

    def send_head(self):
        self._strip_conditional()
        path = self.translate_path(self.path)
        if os.path.isfile(path):
            try:
                etag = _etag(path)
            except OSError:
                etag = None
            if etag and etag in self.headers.get('If-None-Match', ''):
                self.send_response(304)
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                return None  # 304 已发送，do_GET 收到 None 直接结束（零下载）
        return super().send_head()

    def do_GET(self):
        super().do_GET()

    def do_HEAD(self):
        super().do_HEAD()


class ThreadedServer(http.server.ThreadingHTTPServer):
    # v2.23.1 手机并发拉 11+ 个 GLB 时，默认 backlog=5 会溢出 → ERR_CONNECTION_REFUSED
    # → 客户端整库回退程序化兜底车（"所有车模都不对了"）。backlog 加大 + 线程随主退出。
    request_queue_size = 128
    daemon_threads = True


def make(port, tls=False):
    httpd = ThreadedServer(
        ('0.0.0.0', port),
        functools.partial(RevalidateHandler, directory='.'),
    )
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain('cert.pem', 'key.pem')
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f'serving on 0.0.0.0:{port} tls={tls}', flush=True)
    httpd.serve_forever()


threading.Thread(target=lambda: make(8010), daemon=True).start()
make(8443, tls=True)
