import copy
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'infra/ranking'))
import access
import handler


class Conflict(Exception):
    response={'Error':{'Code':'TransactionCanceledException'}}


class MemoryStore:
    def __init__(self):self.items={};self.race=None
    def get(self,key):return copy.deepcopy(self.items.get(key))
    def put(self,row):
        if row['id'] in self.items:raise Conflict()
        self.items[row['id']]=copy.deepcopy(row)
    def update(self,key,values):
        if key not in self.items:raise Conflict()
        self.items[key].update(copy.deepcopy(values));return self.get(key)
    def delete(self,key):del self.items[key]
    def list(self,kind,cursor=None):return sorted([copy.deepcopy(r) for r in self.items.values() if r['kind']==kind],key=lambda r:r['createdAt'],reverse=True),None
    def issue(self,share_id,device,now):
        if self.race:self.race(self);self.race=None
        share=self.items['share#'+share_id]
        if share['status']!='active' or share['expiresAt']<=now:raise Conflict()
        self.put(device);share['claimCount']+=1
    def touch(self,device,values):
        if self.items.get(device['id'],{}).get('status')!='active':
            error=Conflict();error.response={'Error':{'Code':'ConditionalCheckFailedException'}};raise error
        return self.update(device['id'],values)
    def visit(self,device,row):
        if self.race:self.race(self);self.race=None
        if self.items.get(device['id'],{}).get('status')!='active' or self.items[device['id']].get('lastVisitAt',0)>row['visitedAt']-access.VISIT_SECONDS:raise Conflict()
        self.put(row);self.update(device['id'],{'lastVisitId':row['id'],'lastVisitAt':row['visitedAt'],'lastSeenAt':row['createdAt'],'visitCount':device.get('visitCount',0)+1,'trainerName':row['trainerName'],'userAgent':row['userAgent']})


def event(path,method='POST',data=None,claims=None,headers=None):
    return {'rawPath':path,'requestContext':{'http':{'method':method},'authorizer':{'jwt':{'claims':claims or {}}}},'headers':{'content-type':'application/json','origin':'https://pokemon.pir.kr','user-agent':'iPhone Safari',**(headers or {})},'body':json.dumps(data or {})}


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'ADMIN_CLIENT_ID':'admin-client','SITE_ORIGIN':'https://pokemon.pir.kr','SHARE_ORIGIN':'https://pokemon.pir.kr','CLOUDFRONT_PUBLIC_KEY_ID':'KEYID','AUTH_REQUIRED':'1'});self.env.start();self.addCleanup(self.env.stop)
        self.db=MemoryStore();self.now=1791400000;self.claims={'sub':'admin','cognito:groups':'["admins"]','token_use':'access','client_id':'admin-client'}
    def call(self,path,method='POST',data=None,admin=False,now=None,claims=None):
        return access.dispatch(event(path,method,data,claims or (self.claims if admin else None)),storage=self.db,now=self.now if now is None else now,signer=lambda _:b'signature')
    def share(self):return self.call('/api/admin/shares',data={'label':'친구들'},admin=True)[1]['share']
    def device(self):
        share=self.share();result=self.call('/api/access/claim',data={'shareKey':share['url'].rsplit('/',1)[1]})
        return share,result[1]['deviceKey'],result[1]['device']
    def test_share_is_three_days_and_device_secret_is_returned_once_and_hashed(self):
        share,key,device=self.device();self.assertEqual(share['expiresAt']-self.now,3*86400);self.assertRegex(key,access.DEVICE_PATTERN)
        row=self.db.get('device#'+device['deviceId']);self.assertEqual(row['tokenHash'],access.digest(key));self.assertNotIn('expiresAt',row)
        listing=self.call('/api/admin/devices','GET',admin=True)[1]['items'];self.assertNotIn('tokenHash',listing[0]);self.assertNotIn(key,json.dumps(listing))
        self.assertEqual(self.db.get('share#'+share['shareId'])['claimCount'],1)
    def test_expired_invitation_denies_new_devices_but_existing_device_never_expires(self):
        share,key,device=self.device();when=share['expiresAt']
        with self.assertRaises(access.AccessError) as caught:self.call('/api/access/claim',data={'shareKey':share['url'].rsplit('/',1)[1]},now=when)
        self.assertEqual(caught.exception.reason,'invalid_invite')
        result=self.call('/api/access/claim',data={'shareKey':'invalid','deviceKey':key},now=when+10*365*86400)
        self.assertTrue(result[1]['reused']);self.assertNotIn('deviceKey',result[1]);self.assertEqual(len([r for r in self.db.items.values() if r['kind']=='device']),1)
    def test_visit_records_trainer_and_user_agent_and_refresh_does_not_add_a_visit(self):
        _,key,device=self.device();self.call('/api/access/validate',data={'deviceKey':key,'trainerName':'지우'})
        visits=self.call('/api/admin/visits','GET',admin=True)[1]['items'];self.assertEqual(len(visits),1);self.assertEqual(visits[0]['trainerName'],'지우');self.assertEqual(visits[0]['userAgent'],'iPhone Safari')
        self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':False},now=self.now+600);self.assertEqual(self.db.get('device#'+device['deviceId'])['visitCount'],1)
    def test_name_entered_after_first_visit_updates_device_and_initial_visit(self):
        _,key,device=self.device();self.call('/api/access/validate',data={'deviceKey':key});self.call('/api/access/profile',data={'deviceKey':key,'trainerName':'피카츄'})
        self.assertEqual(self.db.get('device#'+device['deviceId'])['trainerName'],'피카츄');self.assertEqual(self.call('/api/admin/visits','GET',admin=True)[1]['items'][0]['trainerName'],'피카츄')
    def test_block_delete_and_unblock_recheck_key_and_clear_signed_cookies(self):
        _,key,device=self.device();url='/api/admin/devices/'+device['deviceId'];self.call(url,'PATCH',{'action':'block'},admin=True)
        result=handler.handle(event('/api/access/validate',data={'deviceKey':key}),access_storage=self.db)
        self.assertEqual(result['statusCode'],403);self.assertEqual(json.loads(result['body'])['reason'],'invalid_device');self.assertEqual(len(result['cookies']),4);self.assertTrue(all('Max-Age=0' in c for c in result['cookies']))
        self.call(url,'PATCH',{'action':'unblock'},admin=True);self.assertTrue(self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':False})[1]['valid'])
        self.call(url,'DELETE',admin=True)
        with self.assertRaises(access.AccessError):access.require_device(key,self.db,self.now)
    def test_revoking_invite_stops_new_devices_without_revoking_existing_devices(self):
        share,key,_=self.device();self.call('/api/admin/shares/'+share['shareId'],'PATCH',{'action':'revoke'},admin=True)
        with self.assertRaises(access.AccessError):self.call('/api/access/claim',data={'shareKey':share['url'].rsplit('/',1)[1]})
        self.assertTrue(self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':False})[1]['valid'])
    def test_hard_deleting_share_removes_row_and_denies_new_grants_but_keeps_existing_device(self):
        share,key,device=self.device();url='/api/admin/shares/'+share['shareId']
        with self.assertRaises(access.AccessError):self.call(url,'DELETE')
        self.assertIsNotNone(self.db.get('share#'+share['shareId']))
        result=self.call(url,'DELETE',admin=True)
        self.assertEqual(result[1],{'deleted':True});self.assertIsNone(self.db.get('share#'+share['shareId']))
        self.assertEqual(self.call('/api/admin/shares','GET',admin=True)[1]['items'],[])
        with self.assertRaises(access.AccessError) as error:self.call('/api/access/claim',data={'shareKey':share['url'].rsplit('/',1)[1]})
        self.assertEqual(error.exception.reason,'invalid_invite')
        self.assertTrue(self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':False})[1]['valid'])
        self.assertEqual(self.call('/api/admin/devices','GET',admin=True)[1]['items'][0]['deviceId'],device['deviceId'])
        with self.assertRaises(access.AccessError) as error:self.call(url,'DELETE',admin=True)
        self.assertEqual(error.exception.status,404)
    def test_invitation_revoked_during_issuance_never_creates_a_device(self):
        share=self.share();self.db.race=lambda db:db.update('share#'+share['shareId'],{'status':'revoked'})
        with self.assertRaises(access.AccessError) as error:self.call('/api/access/claim',data={'shareKey':share['url'].rsplit('/',1)[1]})
        self.assertEqual(error.exception.reason,'invalid_invite');self.assertEqual(self.db.list('device')[0],[])
    def test_device_blocked_during_visit_is_denied(self):
        _,key,device=self.device();self.db.race=lambda db:db.update('device#'+device['deviceId'],{'status':'blocked'})
        with self.assertRaises(access.AccessError) as error:self.call('/api/access/validate',data={'deviceKey':key})
        self.assertEqual(error.exception.reason,'invalid_device');self.assertEqual(self.db.list('visit')[0],[])
    def test_background_visit_records_access_without_extending_cookie_session(self):
        _,key,device=self.device()
        status,data,cookies=self.call('/api/access/profile',data={'deviceKey':key,'trainerName':'지우','recordVisit':True})
        self.assertEqual(status,200);self.assertEqual(data['device']['visitCount'],1);self.assertIsNone(cookies)
        self.assertEqual(self.call('/api/admin/visits','GET',admin=True)[1]['items'][0]['trainerName'],'지우')
        self.call('/api/admin/devices/'+device['deviceId'],'PATCH',{'action':'block'},admin=True)
        with self.assertRaises(access.AccessError):self.call('/api/access/profile',data={'deviceKey':key,'recordVisit':True})
    def test_reloads_coalesce_for_thirty_minutes_while_last_seen_keeps_updating(self):
        _,key,device=self.device()
        for seconds in [0,1,60,1799]:
            self.call('/api/access/profile',data={'deviceKey':key,'trainerName':'지우','recordVisit':True},now=self.now+seconds)
        self.assertEqual(len(self.db.list('visit')[0]),1)
        row=self.db.get('device#'+device['deviceId'])
        self.assertEqual(row['visitCount'],1);self.assertEqual(row['lastSeenAt'],access.iso(self.now+1799));self.assertEqual(row['lastVisitAt'],self.now)
        self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':True},now=self.now+1800)
        self.assertEqual(len(self.db.list('visit')[0]),2)
        self.call('/api/access/validate',data={'deviceKey':key,'recordVisit':False},now=self.now+3600)
        self.assertEqual(len(self.db.list('visit')[0]),2)
    def test_concurrent_reload_does_not_duplicate_visit(self):
        _,key,device=self.device()
        def race(db):
            db.put({'id':'visit#other','kind':'visit','deviceId':device['deviceId'],'trainerName':'지우','createdAt':access.iso(self.now)})
            db.update('device#'+device['deviceId'],{'lastVisitAt':self.now,'visitCount':1})
        self.db.race=race
        self.assertTrue(self.call('/api/access/profile',data={'deviceKey':key,'recordVisit':True})[1]['valid'])
        self.assertEqual(len(self.db.list('visit')[0]),1);self.assertEqual(self.db.get('device#'+device['deviceId'])['visitCount'],1)
    def test_short_reload_window_still_rejects_blocked_devices(self):
        _,key,device=self.device();self.call('/api/access/profile',data={'deviceKey':key,'recordVisit':True})
        self.call('/api/admin/devices/'+device['deviceId'],'PATCH',{'action':'block'},admin=True)
        with self.assertRaises(access.AccessError):self.call('/api/access/profile',data={'deviceKey':key,'recordVisit':True},now=self.now+10)
        self.assertEqual(len(self.db.list('visit')[0]),1)
    def test_wrong_secret_cannot_impersonate_known_device(self):
        _,key,_=self.device();forged=key.split('.')[0]+'.'+'z'*43
        with self.assertRaises(access.AccessError):access.require_device(forged,self.db,self.now)
    def test_administrator_requires_verified_access_claims_and_group_and_correct_client(self):
        for claims in [{},{**self.claims,'token_use':'id'},{**self.claims,'client_id':'other'},{**self.claims,'cognito:groups':'["users"]'},{**self.claims,'sub':''}]:
            with self.subTest(claims=claims),self.assertRaises(access.AccessError):self.call('/api/admin/devices','GET',claims=claims)
        for groups in ['admins','[admins]','["admins"]',['admins']]:
            self.assertEqual(access.require_admin(event('/',claims={**self.claims,'cognito:groups':groups})),'admin')
    def test_rankings_are_rejected_before_any_ranking_db_read_if_key_is_missing(self):
        class ForbiddenTable:
            def get_item(self,**kwargs):raise AssertionError('ranking data must remain private')
        response=handler.handle(event('/api/rankings','GET'),storage=ForbiddenTable(),access_storage=self.db)
        self.assertEqual(response['statusCode'],401);self.assertEqual(json.loads(response['body'])['reason'],'invalid_device')
    def test_cookie_signature_and_policy_verify_with_rsa_sha256(self):
        public,private=access.rsa.newkeys(512)
        cookies=access.signed_cookies(self.now,lambda data:access.rsa.sign(data,private,'SHA-256'))
        values={c.split('=',1)[0]:c.split('=',1)[1].split(';',1)[0] for c in cookies}
        import base64
        decode=lambda s:base64.b64decode(s.translate(str.maketrans('-_~','+=/')))
        policy=decode(values['CloudFront-Policy']);signature=decode(values['CloudFront-Signature'])
        self.assertEqual(access.rsa.verify(policy,signature,public),'SHA-256');self.assertEqual(values['CloudFront-Hash-Algorithm'],'SHA256');self.assertEqual(values['CloudFront-Key-Pair-Id'],'KEYID')
        document=json.loads(policy);self.assertEqual(document['Statement'][0]['Resource'],'https://pokemon.pir.kr/*');self.assertEqual(document['Statement'][0]['Condition']['DateLessThan']['AWS:EpochTime'],self.now+8*60*60)
        self.assertTrue(all('Secure; HttpOnly; SameSite=Lax' in c and 'Max-Age=28800' in c for c in cookies))
    def test_public_configuration_does_not_need_database_or_expose_a_secret(self):
        with patch.object(access,'store',side_effect=AssertionError('unnecessary database read')):
            result=access.dispatch(event('/api/access/config','GET'))
        self.assertEqual(result[0],200);self.assertTrue(result[1]['enabled']);self.assertNotIn('signing',json.dumps(result[1]).lower())
    def test_malformed_large_and_control_character_payloads_are_rejected(self):
        for data in [[],None,'string']:
            e=event('/api/access/claim');e['body']=json.dumps(data)
            with self.assertRaises(access.AccessError):access.dispatch(e,self.db,now=self.now)
        for name in ['x'*13,'a\x00']:
            with self.assertRaises(access.AccessError):access.trainer_name(name)
        e=event('/api/access/claim');e['body']='x'*9000
        with self.assertRaises(access.AccessError):access.decode_body(e)
        self.assertEqual(access.trainer_name(' 지우 '),'지우')
