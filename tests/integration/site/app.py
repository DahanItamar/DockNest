import http.server, sqlite3, pathlib, signal, threading, os, urllib.request

root = pathlib.Path('/site')
root.mkdir(exist_ok=True)
with sqlite3.connect(root / 'database.sqlite') as db:
    db.execute('CREATE TABLE IF NOT EXISTS records(value TEXT)')
    if not db.execute('SELECT 1 FROM records').fetchone():
        db.execute("INSERT INTO records VALUES ('snapshot-record')")
asset = root / 'asset.txt'
if not asset.exists():
    asset.write_text('snapshot-asset')
    asset.chmod(0o640)
    os.chown(asset,1234,2345)
if not os.path.lexists(root/'asset-link.txt'):os.symlink('asset.txt',root/'asset-link.txt')
if not (root/'asset-hardlink.txt').exists():os.link(asset,root/'asset-hardlink.txt')
writable = pathlib.Path('/app/writable.txt')
if not writable.exists(): writable.write_text('snapshot-layer')
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if os.environ.get('PEER_HEALTH'):
            try:
                with urllib.request.urlopen(os.environ['PEER_HEALTH'],timeout=1) as response:
                    if response.status!=200:raise ValueError('Peer unavailable')
            except Exception:
                self.send_response(503);self.end_headers();return
        if self.path=='/record':
            with sqlite3.connect(root/'database.sqlite') as db:value=db.execute('SELECT value FROM records').fetchone()[0]
            self.send_response(200);self.end_headers();self.wfile.write(value.encode());return
        self.send_response(200); self.end_headers(); self.wfile.write(b'fixture healthy')
    def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler)
def stop(*args): threading.Thread(target=server.shutdown).start()
signal.signal(signal.SIGTERM, stop)
server.serve_forever()
