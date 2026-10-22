"""Loopback preview with isolated in-memory rankings; never contacts production DBs."""
import copy
import json
import os
import re
import sys
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'infra/ranking'))
import handler as rankings
import settings as gameplay_settings
WEB_ROOT=Path(os.environ.get('POKEMON_LOCAL_WEB_ROOT',str(ROOT/'dist'))).resolve()
SETTINGS_FILE=Path(os.environ.get('POKEMON_LOCAL_SETTINGS_FILE',str(ROOT/'exports/local-game-settings.json')))
SETTINGS_LOCK=threading.Lock()


def read_settings():
    if SETTINGS_FILE.exists():return gameplay_settings.validate(json.loads(SETTINGS_FILE.read_text()))
    return copy.deepcopy(gameplay_settings.DEFAULT)


class LocalRankings:
    def __init__(self):self.items={}
    def get_item(self,Key,ConsistentRead):
        item=self.items.get(Key['mode']);return {'Item':copy.deepcopy(item)} if item else {}
    def put_item(self,**kwargs):
        item=kwargs['Item'];key=item['mode']
        if key.startswith('history#') and key in self.items:
            error=Exception('archive already exists');error.response={'Error':{'Code':'ConditionalCheckFailedException'}};raise error
        self.items[key]=copy.deepcopy(item)


LOCAL_RANKINGS=LocalRankings()
RANKING_LOCK=threading.Lock()


class LocalServer(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(WEB_ROOT),**kwargs)
    def translate_path(self,path):
        built=super().translate_path(path)
        if WEB_ROOT!=ROOT/'dist' and not Path(built).exists():
            original=ROOT/'dist'/Path(built).relative_to(WEB_ROOT)
            if original.is_file():return str(original)
        return built
    def end_headers(self):
        if not urlsplit(self.path).path.startswith('/api/'):
            self.send_header('Cache-Control','no-store, max-age=0')
        self.send_header('Pragma','no-cache');self.send_header('Expires','0')
        super().end_headers()
    def send_head(self):
        # Always serve current preview files, even with stale conditional headers.
        for name in ['If-Modified-Since','If-None-Match']:
            if name in self.headers:del self.headers[name]
        return super().send_head()
    def ranking_response(self):
        # Call only pure scoring/board helpers, never the AWS authentication/storage path.
        try:
            with RANKING_LOCK:
                if self.command=='GET':
                    query=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                    mode=rankings.valid_mode(query.get('mode',[''])[0])
                    month=rankings.valid_month(query['month'][0]) if 'month' in query else None
                    _,entries=rankings.board(LOCAL_RANKINGS,mode,month)
                    personal={'personalBest':rankings.personal_best(LOCAL_RANKINGS,mode,query['trainer'][0])} if 'trainer' in query else {}
                    result=rankings.response(200,rankings.public_result({'mode':mode,'entries':entries,'serverTime':rankings.timestamp(),**({'month':month} if month else {}),**personal}))
                else:
                    if not self.headers.get('Content-Type','').lower().startswith('application/json'):
                        raise rankings.RequestError(415,'기록을 읽지 못했어. 다시 저장해줘.')
                    try:length=int(self.headers.get('Content-Length','0'))
                    except ValueError:raise rankings.RequestError(400,'기록을 읽지 못했어. 다시 저장해줘.')
                    if not 0<=length<=8192:raise rankings.RequestError(413,'기록이 너무 길어졌어.')
                    try:body=self.rfile.read(length).decode('utf-8')
                    except UnicodeError:raise rankings.RequestError(400,'기록을 읽지 못했어. 다시 저장해줘.')
                    submitted=rankings.parse_submission({'body':body})
                    device=self.headers.get('X-Preview-Device-Id','')
                    if re.fullmatch(r'[a-f0-9]{32}',device):submitted['deviceId']='local-'+device
                    submitted['userAgent']=self.headers.get('User-Agent','')[:240]
                    query=parse_qs(urlsplit(self.path).query,keep_blank_values=True)
                    if 'month' in query:rankings.valid_month(query['month'][0])
                    result=rankings.response(200,rankings.public_result(rankings.save_with_monthly(LOCAL_RANKINGS,submitted,'month' in query)))
        except rankings.RequestError as error:result=rankings.response(error.status,{'error':error.message})
        self.send_response(result['statusCode'])
        for key,value in result['headers'].items():self.send_header(key,value)
        self.end_headers();self.wfile.write(result['body'].encode('utf-8'))
    def settings_response(self):
        try:
            if self.command=='PUT':
                try:
                    length=int(self.headers.get('Content-Length','0'))
                    if not 1<=length<=8192:raise ValueError()
                    raw=self.rfile.read(length)
                except ValueError:raise rankings.RequestError(400,'설정을 다시 확인해 주세요.')
                origin=self.headers.get('Origin')
                if self.headers.get('X-Local-Admin')!='1' or self.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and origin not in ['http://'+self.headers.get('Host','')]):
                    raise rankings.RequestError(403,'로컬 관리자 화면에서 설정해 주세요.')
                if not self.headers.get('Content-Type','').startswith('application/json'):
                    raise rankings.RequestError(415,'설정을 다시 확인해 주세요.')
                try:
                    data=gameplay_settings.validate(json.loads(raw))
                except (ValueError,TypeError,UnicodeError) as error:raise rankings.RequestError(400,str(error) or '설정을 다시 확인해 주세요.')
                with SETTINGS_LOCK:
                    if data['version']!=read_settings()['version']:raise rankings.RequestError(409,'다른 설정이 먼저 저장됐어요. 최신 설정을 다시 불러와 주세요.')
                    data['version']+=1;SETTINGS_FILE.parent.mkdir(parents=True,exist_ok=True)
                    temporary=SETTINGS_FILE.with_suffix('.tmp');temporary.write_text(json.dumps(data));temporary.chmod(0o600);temporary.replace(SETTINGS_FILE)
            else:
                with SETTINGS_LOCK:data=read_settings()
            result=rankings.response(200,{'settings':data,**({'pokemonNames':gameplay_settings.NAMES} if self.path.startswith('/api/admin/') else {})})
        except rankings.RequestError as error:result=rankings.response(error.status,{'error':error.message})
        except (ValueError,OSError):result=rankings.response(503,{'error':'설정을 읽지 못했어요. 다시 확인해 주세요.'})
        self.send_response(result['statusCode'])
        for key,value in result['headers'].items():self.send_header(key,value)
        self.end_headers();self.wfile.write(result['body'].encode())
    def do_GET(self):
        path=urlsplit(self.path).path
        if path in ['/api/game-settings','/api/admin/game-settings']:self.settings_response();return
        if path=='/api/rankings':self.ranking_response();return
        if path=='/api/access/config':
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers()
            self.wfile.write(json.dumps({'enabled':False,'localPreview':True,'admin':{'clientId':''}}).encode());return
        if path in ['/admin','/admin/']:self.path='/admin.html'
        super().do_GET()
    def do_POST(self):
        if urlsplit(self.path).path=='/api/scores':self.ranking_response();return
        self.send_error(404)
    def do_PUT(self):
        if urlsplit(self.path).path=='/api/admin/game-settings':self.settings_response();return
        self.send_error(404)


if __name__=='__main__':
    print('Local game preview: http://127.0.0.1:4173 (local rankings only; cleared on restart)',flush=True)
    ThreadingHTTPServer(('127.0.0.1',4173),LocalServer).serve_forever()
