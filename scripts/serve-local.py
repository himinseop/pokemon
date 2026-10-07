"""Serve the game on loopback only; production admission always uses the AWS API."""
import json
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class LocalServer(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'dist'),**kwargs)
    def do_GET(self):
        path=self.path.split('?',1)[0]
        if path=='/api/access/config':
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers()
            self.wfile.write(json.dumps({'enabled':False,'admin':{'clientId':''}}).encode());return
        if path in ['/admin','/admin/']:self.path='/admin.html'
        super().do_GET()
if __name__=='__main__':
    print('Local game preview: http://127.0.0.1:4173 (invitation checks disabled only on loopback)')
    ThreadingHTTPServer(('127.0.0.1',4173),LocalServer).serve_forever()
