"""The preview exercises real score parsing without production authentication or DBs."""
import importlib.util
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec=importlib.util.spec_from_file_location('local_preview',Path(__file__).resolve().parents[1]/'scripts/serve-local.py')
preview=importlib.util.module_from_spec(spec);spec.loader.exec_module(preview)


class LocalPreview(unittest.TestCase):
    def test_preview_records_partners_in_isolated_memory_without_cloud_calls(self):
        class QuietServer(preview.LocalServer):
            def log_message(self,*args):pass
        with patch.object(preview,'LOCAL_RANKINGS',preview.LocalRankings()),patch.object(preview.rankings,'table',side_effect=AssertionError('must not use AWS')) as cloud:
            server=ThreadingHTTPServer(('127.0.0.1',0),QuietServer);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                root=f'http://127.0.0.1:{server.server_address[1]}'
                def request(path,data=None):
                    req=Request(root+path,data=json.dumps(data).encode() if data else None,headers={'Content-Type':'application/json','X-Preview-Device-Id':'a'*32,'User-Agent':'Local test browser'})
                    try:
                        with urlopen(req,timeout=2) as response:return response.status,json.load(response)
                    except HTTPError as error:
                        with error:return error.code,json.load(error)
                for path in ['/', '/game.html', '/app.js', '/style.css']:
                    req=Request(root+path,headers={'If-Modified-Since':'Thu, 01 Jan 2099 00:00:00 GMT'})
                    with urlopen(req,timeout=2) as response:
                        self.assertEqual(response.status,200);self.assertIn('no-store',response.headers['Cache-Control']);response.read()
                self.assertFalse(request('/api/access/config')[1]['enabled'])
                self.assertEqual(request('/api/rankings?mode=time-easy')[1]['entries'],[])
                payload={'id':'local-preview-record-001','name':'지우','mode':'time-easy','results':[True],'partnerId':25}
                status,data=request('/api/scores',payload);self.assertEqual(status,200);self.assertEqual(data['record']['partnerId'],25)
                stored=preview.LOCAL_RANKINGS.items['time-easy']['entries'][0];self.assertEqual(stored['deviceId'],'local-'+'a'*32);self.assertEqual(stored['userAgent'],'Local test browser');self.assertNotIn('deviceId',data['record'])
                self.assertEqual(request('/api/rankings?mode=time-easy')[1]['entries'][0]['partnerId'],25)
                before=preview.LOCAL_RANKINGS.items.copy();self.assertEqual(request('/api/scores',{**payload,'partnerId':1026})[0],400)
                self.assertEqual(preview.LOCAL_RANKINGS.items,before);cloud.assert_not_called()
            finally:server.shutdown();server.server_close();thread.join(timeout=2)
