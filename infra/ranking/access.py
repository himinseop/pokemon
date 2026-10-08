"""Invitation grants, persistent browser keys, access logs and administrator actions."""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'vendor'))
import rsa

SHARE_SECONDS = 3 * 86400
SESSION_SECONDS = 8 * 60 * 60
VISIT_SECONDS = 30 * 60
DEVICE_PATTERN = re.compile(r'^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$')
SHARE_PATTERN = re.compile(r'^[A-Za-z0-9_-]{43}$')
COOKIES = ('CloudFront-Policy', 'CloudFront-Signature', 'CloudFront-Key-Pair-Id', 'CloudFront-Hash-Algorithm')
_STORE = None
_SIGNING_KEY = None


class AccessError(Exception):
    def __init__(self, status, message, reason=None):
        self.status, self.message, self.reason = status, message, reason


def iso(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def digest(value):
    return hashlib.sha256(value.encode('ascii')).hexdigest()


def decode_body(event):
    try:
        raw = event.get('body') or '{}'
        if not isinstance(raw, str) or len(raw.encode()) > 8192:
            raise ValueError()
        if event.get('isBase64Encoded'):
            raw = base64.b64decode(raw, validate=True).decode()
        data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except (ValueError, UnicodeError):
        raise AccessError(400, '요청을 읽지 못했어. 다시 해볼까?')


def trainer_name(value):
    if not isinstance(value, str):
        raise AccessError(400, '이름을 다시 적어줘.')
    value = unicodedata.normalize('NFKC', value).strip()
    if len(value) > 12 or any(unicodedata.category(c).startswith('C') for c in value):
        raise AccessError(400, '이름을 12자 안으로 적어줘.')
    return value


class DynamoStore:
    def __init__(self):
        import boto3
        from boto3.dynamodb.types import TypeSerializer
        from botocore.config import Config
        self.table = boto3.resource('dynamodb', config=Config(connect_timeout=2, read_timeout=2, retries={'max_attempts': 2})).Table(os.environ['ACCESS_TABLE_NAME'])
        self.client, self.name, self.serializer = boto3.client('dynamodb', config=Config(connect_timeout=2, read_timeout=2, retries={'max_attempts': 2})), self.table.name, TypeSerializer()
    def get(self, key):
        return self.table.get_item(Key={'id': key}, ConsistentRead=True).get('Item')
    def put(self, item):
        self.table.put_item(Item=item, ConditionExpression='attribute_not_exists(id)')
    def update(self, key, values):
        names = {f'#n{i}': name for i, name in enumerate(values)}
        params = {f':v{i}': value for i, value in enumerate(values.values())}
        return self.table.update_item(Key={'id': key}, ConditionExpression='attribute_exists(id)', UpdateExpression='SET '+', '.join(f'#n{i}=:v{i}' for i in range(len(values))), ExpressionAttributeNames=names, ExpressionAttributeValues=params, ReturnValues='ALL_NEW')['Attributes']
    def delete(self, key):
        self.table.delete_item(Key={'id': key}, ConditionExpression='attribute_exists(id)')
    def list(self, kind, cursor=None, device_id=None):
        args = {'IndexName': 'byKind', 'KeyConditionExpression': '#kind=:kind', 'ExpressionAttributeNames': {'#kind':'kind'}, 'ExpressionAttributeValues': {':kind':kind}, 'ScanIndexForward': False, 'Limit':50}
        if device_id is not None:
            args['FilterExpression']='#device=:device';args['ExpressionAttributeNames']['#device']='deviceId';args['ExpressionAttributeValues'][':device']=device_id
        if cursor:
            try:
                start = json.loads(base64.urlsafe_b64decode(cursor))
                if not isinstance(start, dict) or set(start) != {'id','kind','createdAt'} or start['kind'] != kind or any(not isinstance(v,str) for v in start.values()): raise ValueError()
                args['ExclusiveStartKey'] = start
            except (ValueError, TypeError): raise AccessError(400, '목록을 다시 불러와 주세요.')
        for _ in range(5):
            result = self.table.query(**args)
            next_key = result.get('LastEvaluatedKey')
            if not device_id or result.get('Items') or not next_key:break
            args['ExclusiveStartKey']=next_key
        return result.get('Items', []), base64.urlsafe_b64encode(json.dumps(next_key).encode()).decode() if next_key else None
    def issue(self, share_id, device, now):
        # Grant and counter update commit together: a revoked/expired link cannot race issuance.
        serialize = lambda value: self.serializer.serialize(value)
        self.client.transact_write_items(TransactItems=[
            {'Update': {'TableName':self.name, 'Key':{'id':serialize('share#'+share_id)}, 'UpdateExpression':'ADD claimCount :one', 'ConditionExpression':'#status=:active AND expiresAt>:now', 'ExpressionAttributeNames':{'#status':'status'}, 'ExpressionAttributeValues':{':one':serialize(1),':active':serialize('active'),':now':serialize(now)}}},
            {'Put': {'TableName':self.name, 'Item':{k:serialize(v) for k,v in device.items()}, 'ConditionExpression':'attribute_not_exists(id)'}}
        ])
    def touch(self, device, values):
        names = {f'#n{i}':name for i,name in enumerate(values)} | {'#status':'status'}
        params = {f':v{i}':value for i,value in enumerate(values.values())} | {':active':'active'}
        return self.table.update_item(Key={'id':device['id']},ConditionExpression='#status=:active',UpdateExpression='SET '+', '.join(f'#n{i}=:v{i}' for i in range(len(values))),ExpressionAttributeNames=names,ExpressionAttributeValues=params,ReturnValues='ALL_NEW')['Attributes']
    def visit(self, device, visit):
        serialize = lambda value: self.serializer.serialize(value)
        updates = {'lastSeenAt':visit['createdAt'], 'lastVisitId':visit['id'], 'lastVisitAt':visit['visitedAt'], 'trainerName':visit['trainerName'], 'userAgent':visit['userAgent']}
        names = {'#status':'status',**{f'#n{i}':key for i,key in enumerate(updates)}}
        values = {':active':serialize('active'),':one':serialize(1),':cutoff':serialize(visit['visitedAt']-VISIT_SECONDS),**{f':v{i}':serialize(v) for i,v in enumerate(updates.values())}}
        self.client.transact_write_items(TransactItems=[
            {'Update': {'TableName':self.name,'Key':{'id':serialize(device['id'])},'UpdateExpression':'SET '+', '.join(f'#n{i}=:v{i}' for i in range(len(updates)))+' ADD visitCount :one','ConditionExpression':'#status=:active AND (attribute_not_exists(lastVisitAt) OR lastVisitAt<=:cutoff)','ExpressionAttributeNames':names,'ExpressionAttributeValues':values}},
            {'Put': {'TableName':self.name,'Item':{k:serialize(v) for k,v in visit.items()},'ConditionExpression':'attribute_not_exists(id)'}}
        ])


def store():
    global _STORE
    if _STORE is None: _STORE = DynamoStore()
    return _STORE


def require_device(token, storage=None, now=None):
    if not isinstance(token, str) or not DEVICE_PATTERN.fullmatch(token):
        raise AccessError(401, '파티 초대장이 필요합니다', 'invalid_device')
    storage, now = storage if storage is not None else store(), int(time.time() if now is None else now)
    device = storage.get('device#'+token.split('.')[0])
    if not device or not hmac.compare_digest(str(device.get('tokenHash','')),digest(token)):
        raise AccessError(401, '파티 초대장이 필요합니다', 'invalid_device')
    if device.get('status') != 'active' or device.get('expiresAt') is not None and now >= device['expiresAt']:
        raise AccessError(403, '파티 초대장이 필요합니다', 'invalid_device')
    return device


def require_admin(event):
    claims = event.get('requestContext',{}).get('authorizer',{}).get('jwt',{}).get('claims',{})
    groups = claims.get('cognito:groups',[])
    if isinstance(groups,str):
        try: groups=json.loads(groups)
        except ValueError: groups=[group.strip().strip("'\"") for group in groups.strip('[]').split(',')]
    if not isinstance(groups,list) or 'admins' not in groups or claims.get('token_use') != 'access' or claims.get('client_id') != os.environ.get('ADMIN_CLIENT_ID') or not claims.get('sub'):
        raise AccessError(403, '관리자 로그인이 필요합니다', 'admin_required')
    return claims['sub']


def encode_cf(value):
    return base64.b64encode(value).decode().translate(str.maketrans('+=/', '-_~'))


def signed_cookies(now=None, signer=None):
    global _SIGNING_KEY
    now=int(time.time() if now is None else now)
    origin=os.environ.get('SITE_ORIGIN','https://pokemon.pir.kr')
    policy=json.dumps({'Statement':[{'Resource':origin+'/*','Condition':{'DateLessThan':{'AWS:EpochTime':now+SESSION_SECONDS}}}]},separators=(',',':')).encode()
    if signer is None:
        if _SIGNING_KEY is None:
            import boto3
            pem=boto3.client('ssm').get_parameter(Name=os.environ['SIGNING_PARAMETER_NAME'],WithDecryption=True)['Parameter']['Value']
            _SIGNING_KEY=rsa.PrivateKey.load_pkcs1(pem.encode())
        signer=lambda message:rsa.sign(message,_SIGNING_KEY,'SHA-256')
    values=[encode_cf(policy),encode_cf(signer(policy)),os.environ.get('CLOUDFRONT_PUBLIC_KEY_ID',''), 'SHA256']
    return [f'{name}={value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}' for name,value in zip(COOKIES,values)]


def clear_cookies():
    return [f'{name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' for name in COOKIES]


def public_device(row):
    return {key:row[key] for key in ['deviceId','trainerName','createdAt','lastSeenAt','status','visitCount','userAgent'] if key in row}


def public_config():
    return {'enabled':os.environ.get('AUTH_REQUIRED')=='1','siteOrigin':os.environ.get('SITE_ORIGIN','https://pokemon.pir.kr'),'shareOrigin':os.environ.get('SHARE_ORIGIN','https://pokemon.pir.kr'),'inviteDays':3,'verificationSeconds':SESSION_SECONDS,'admin':{'clientId':os.environ.get('ADMIN_CLIENT_ID',''),'loginOrigin':os.environ.get('ADMIN_LOGIN_ORIGIN',''),'redirectUri':os.environ.get('SITE_ORIGIN','https://pokemon.pir.kr')+'/admin'}}


def dispatch(event, storage=None, now=None, signer=None):
    now=int(time.time() if now is None else now)
    path=(event.get('rawPath') or '').rstrip('/')
    method=event.get('requestContext',{}).get('http',{}).get('method')
    headers={key.lower():value for key,value in (event.get('headers') or {}).items()}
    if method=='GET' and path=='/api/access/config': return 200,public_config(),None
    storage=storage if storage is not None else store()
    if path.startswith('/api/admin/'):
        admin=require_admin(event)
        if method=='POST' and path=='/api/admin/shares':
            data=decode_body(event);label=data.get('label','')
            if not isinstance(label,str) or len(label.strip())>60 or any(unicodedata.category(c).startswith('C') for c in label): raise AccessError(400,'링크 이름을 60자 안으로 적어 주세요.')
            key=secrets.token_urlsafe(32);identifier=digest(key)
            row={'id':'share#'+identifier,'shareId':identifier,'key':key,'kind':'share','label':label.strip(),'status':'active','createdAt':iso(now),'expiresAt':now+SHARE_SECONDS,'claimCount':0,'createdBy':admin}
            storage.put(row);return 201,{'share':share_view(row)},None
        if method=='GET' and path in ['/api/admin/shares','/api/admin/devices','/api/admin/visits']:
            kind={'shares':'share','devices':'device','visits':'visit'}[path.rsplit('/',1)[1]]
            params=event.get('queryStringParameters') or {};device_id=params.get('deviceId')
            if device_id is not None and (kind!='visit' or not isinstance(device_id,str) or not re.fullmatch(r'[a-f0-9]{32}',device_id)):raise AccessError(400,'기기 ID를 다시 확인해 주세요.')
            rows,cursor=storage.list(kind,params.get('cursor'),device_id)
            return 200,{'items':[share_view(r) if kind=='share' else public_device(r) if kind=='device' else {k:r[k] for k in ['id','deviceId','trainerName','createdAt','userAgent']} for r in rows],'nextCursor':cursor},None
        match=re.fullmatch(r'/api/admin/(devices|shares)/([a-f0-9]{32}|[a-f0-9]{64})',path)
        if match and method in ['PATCH','DELETE']:
            kind,identifier=match.groups();prefix='device' if kind=='devices' else 'share';row=storage.get(prefix+'#'+identifier)
            if not row: raise AccessError(404,'기록을 찾지 못했습니다.')
            if method=='DELETE':storage.delete(row['id']);return 200,{'deleted':True},None
            action=decode_body(event).get('action')
            allowed={'block':'blocked','unblock':'active'} if prefix=='device' else {'revoke':'revoked'}
            if action not in allowed:raise AccessError(400,'변경할 상태를 확인해 주세요.')
            row=storage.update(row['id'],{'status':allowed[action]});return 200,{'device':public_device(row)} if prefix=='device' else {'share':share_view(row)},None
        raise AccessError(404,'관리자 기능을 찾지 못했습니다.')
    data=decode_body(event) if method=='POST' else {}
    if method=='POST' and path=='/api/access/claim':
        # A known key reuses its grant even after the invitation has expired.
        if data.get('deviceKey'):
            device=require_device(data['deviceKey'],storage,now)
            return 200,{'valid':True,'device':public_device(device),'reused':True},signed_cookies(now,signer)
        key=data.get('shareKey')
        if not isinstance(key,str) or not SHARE_PATTERN.fullmatch(key):raise AccessError(403,'초대 링크를 다시 확인해 줘.','invalid_invite')
        share_id=digest(key);share=storage.get('share#'+share_id)
        if not share or share.get('status')!='active' or now>=share.get('expiresAt',0):raise AccessError(403,'초대 링크의 기간이 지났거나 사용할 수 없어.','invalid_invite')
        device_id=uuid.uuid4().hex;token=device_id+'.'+secrets.token_urlsafe(32)
        device={'id':'device#'+device_id,'deviceId':device_id,'kind':'device','tokenHash':digest(token),'status':'active','trainerName':trainer_name(data.get('trainerName','')),'createdAt':iso(now),'lastSeenAt':iso(now),'visitCount':0,'userAgent':str(headers.get('user-agent',''))[:240],'shareId':share_id}
        try:storage.issue(share_id,device,now)
        except Exception as error:
            if getattr(error,'response',{}).get('Error',{}).get('Code') in ['TransactionCanceledException','ConditionalCheckFailedException']:raise AccessError(403,'초대 링크를 사용할 수 없어.','invalid_invite')
            raise
        return 201,{'valid':True,'deviceKey':token,'device':public_device(device),'reused':False},signed_cookies(now,signer)
    if method=='POST' and path in ['/api/access/validate','/api/access/profile']:
        device=require_device(data.get('deviceKey'),storage,now)
        name=trainer_name(data.get('trainerName',device.get('trainerName','')))
        if path.endswith('/profile') and not data.get('recordVisit',False):
            row=storage.update(device['id'],{'trainerName':name})
            previous=storage.get(device['lastVisitId']) if device.get('lastVisitId') else None
            if previous and not previous.get('trainerName'):storage.update(previous['id'],{'trainerName':name})
            return 200,{'valid':True,'device':public_device(row)},None
        if data.get('recordVisit',True) and name:
            visit={'id':'visit#'+uuid.uuid4().hex,'kind':'visit','deviceId':device['deviceId'],'trainerName':name,'createdAt':iso(now),'visitedAt':now,'userAgent':str(headers.get('user-agent',''))[:240]}
            def touch(current):
                try:return storage.touch(current,{'lastSeenAt':visit['createdAt'],'trainerName':name,'userAgent':visit['userAgent']})
                except Exception as error:
                    if getattr(error,'response',{}).get('Error',{}).get('Code')=='ConditionalCheckFailedException':raise AccessError(403,'파티 초대장이 필요합니다','invalid_device')
                    raise
            if device.get('lastVisitAt',0)>now-VISIT_SECONDS:
                device=touch(device)
            else:
                try:
                    storage.visit(device,visit)
                    device={**device,'trainerName':name,'lastSeenAt':visit['createdAt'],'lastVisitAt':now,'visitCount':device.get('visitCount',0)+1}
                except Exception as error:
                    if getattr(error,'response',{}).get('Error',{}).get('Code') not in ['TransactionCanceledException','ConditionalCheckFailedException']:raise
                    # Concurrent reloads must not create separate visits in the same window.
                    current=require_device(data.get('deviceKey'),storage,now)
                    if current.get('lastVisitAt',0)<=now-VISIT_SECONDS:raise
                    device=touch(current)
        return 200,{'valid':True,'device':public_device(device)},None if path.endswith('/profile') else signed_cookies(now,signer)
    if method=='POST' and path=='/api/access/logout':return 200,{'loggedOut':True},clear_cookies()
    raise AccessError(404,'초대 기능을 찾지 못했어.')


def share_view(row):
    return {key:row[key] for key in ['shareId','label','status','createdAt','expiresAt','claimCount']} | {'url':os.environ.get('SHARE_ORIGIN','https://pokemon.pir.kr')+'/'+row['key']}
