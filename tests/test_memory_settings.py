import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'infra/ranking'))
import access
import settings
from test_rankings import handler, Table, Conflict


class SettingsStore:
    def __init__(self): self.rows={};self.writes=0
    def get(self,key):return copy.deepcopy(self.rows.get(key))
    def save_settings(self,row,expected):
        current=self.rows.get(row['id'])
        if (current and current['settings']['version']!=expected) or (not current and expected):raise Conflict()
        self.rows[row['id']]=copy.deepcopy(row);self.writes+=1


class MemorySettingsTests(unittest.TestCase):
    def event(self,mode='memory-easy',**overrides):
        data={'id':'memory-record-00000001','name':'지우','mode':mode,'durationMs':12000,'moves':8,'pairs':8,**overrides}
        return {'body':json.dumps(data),'headers':{'content-type':'application/json'},'rawPath':'/api/scores','requestContext':{'http':{'method':'POST'}}}
    def test_memory_time_is_validated_independently_and_separate_from_quiz_score(self):
        record=handler.parse_submission(self.event(partnerId=25))
        self.assertEqual(record['durationMs'],12000);self.assertEqual(record['pairs'],8);self.assertEqual(record['score'],0);self.assertEqual(record['partnerId'],25)
        for fields in [{'durationMs':0},{'durationMs':1.5},{'durationMs':True},{'durationMs':86400001},{'moves':7},{'moves':True},{'pairs':6},{'pairs':8.0},{'partnerId':1026}]:
            with self.subTest(fields=fields),self.assertRaises(handler.RequestError):handler.parse_submission(self.event(**fields))
        for mode,pairs in [('memory-normal',12),('memory-hard',15)]:self.assertEqual(handler.parse_submission(self.event(mode,pairs=pairs,moves=pairs))['pairs'],pairs)
    def test_shortest_record_wins_and_all_originals_survive_with_private_device_context(self):
        storage=Table();original=handler.parse_submission(self.event());original.update(deviceId='device-id',userAgent='browser')
        with patch.object(handler,'timestamp',return_value='2026-10-12T01:00:00Z'):handler.save(storage,original)
        faster={**original,'id':'memory-record-00000002','durationMs':8000}
        with patch.object(handler,'timestamp',return_value='2026-10-12T01:01:00Z'):result=handler.save(storage,faster)
        self.assertEqual(result['record']['durationMs'],8000)
        slower={**original,'id':'memory-record-00000003','durationMs':10000}
        result=handler.save(storage,slower);self.assertTrue(result['keptBest']);self.assertEqual(result['record']['id'],faster['id'])
        self.assertEqual(len(storage.items['memory-easy']['entries']),1)
        for row in [original,faster,slower]:self.assertEqual(handler.archived_record(storage,row['mode'],row['id'])['durationMs'],row['durationMs'])
        public=handler.public_result(result);self.assertNotIn('deviceId',public['record']);self.assertNotIn('userAgent',public['entries'][0])
        changed={**faster,'durationMs':7999}
        with self.assertRaises(handler.RequestError):handler.save(storage,changed)
    def test_default_settings_are_detached_and_decimal_storage_roundtrips(self):
        store=SettingsStore();data=settings.read(store);data['familiarIds'].clear();self.assertGreater(len(settings.read(store)['familiarIds']),10)
        saved=settings.save(store,copy.deepcopy(settings.DEFAULT),'admin','now');self.assertEqual(saved['version'],1)
        store.rows[settings.KEY]['settings']=json.loads(json.dumps(saved),parse_int=Decimal)
        self.assertEqual(settings.read(store),saved)
    def test_invalid_settings_and_stale_edits_do_not_write_or_touch_devices(self):
        store=SettingsStore();store.rows['device#untouched']={'id':'device#untouched','trainerName':'친구'}
        invalid=[{'timeFamiliarPercent':{'easy':95,'normal':50,'hard':50}},{'timeFamiliarPercent':{'easy':True,'normal':50,'hard':50}},{'familiarIds':[25]*10},{'familiarIds':list(range(1,10))},{'familiarIds':list(range(1,11))+[1026]},{'version':True}]
        for patchdata in invalid:
            with self.subTest(patchdata=patchdata),self.assertRaises(ValueError):settings.save(store,{**copy.deepcopy(settings.DEFAULT),**patchdata},'admin','now')
        self.assertEqual(store.writes,0);settings.save(store,copy.deepcopy(settings.DEFAULT),'admin','now')
        with self.assertRaises(Conflict):settings.save(store,copy.deepcopy(settings.DEFAULT),'admin','now')
        self.assertEqual(store.rows['device#untouched']['trainerName'],'친구');self.assertEqual(store.writes,1)
    def test_settings_require_admin_and_public_read_requires_invitation(self):
        store=SettingsStore();event={'rawPath':'/api/admin/game-settings','requestContext':{'http':{'method':'PUT'}},'body':json.dumps(settings.DEFAULT)}
        with patch.dict(os.environ,{'ADMIN_CLIENT_ID':'admin-client','AUTH_REQUIRED':'1'}):
            with self.assertRaises(access.AccessError):access.dispatch(event,storage=store)
            claims={'cognito:groups':['admins'],'token_use':'access','client_id':'admin-client','sub':'admin'}
            event['requestContext']['authorizer']={'jwt':{'claims':claims}}
            status,result,_=access.dispatch(event,storage=store);self.assertEqual(status,200);self.assertEqual(result['settings']['version'],1)
            event['requestContext']['http']['method']='GET';status,data,_=access.dispatch(event,storage=store);self.assertEqual(len(data['pokemonNames']),1025)
            public={'rawPath':'/api/game-settings','requestContext':{'http':{'method':'GET'}}}
            response=handler.handle(public,access_storage=store);self.assertIn(response['statusCode'],[401,403])
            with patch.object(access,'require_device',return_value={'deviceId':'valid-device'}):
                response=handler.handle(public,access_storage=store);self.assertEqual(response['statusCode'],200);self.assertEqual(json.loads(response['body'])['settings']['version'],1)
    def test_conditional_sdk_write_does_not_expand_permissions_or_modify_other_rows(self):
        store=object.__new__(access.DynamoStore)
        class FakeTable:
            def put_item(self,**kwargs):self.kwargs=kwargs
        store.table=FakeTable();row={'id':settings.KEY,'settings':{'version':2}}
        store.save_settings(row,1);self.assertEqual(store.table.kwargs['ExpressionAttributeValues'],{':expected':1});self.assertIn('#version',store.table.kwargs['ConditionExpression'])
        store.save_settings(row,0);self.assertEqual(store.table.kwargs['ConditionExpression'],'attribute_not_exists(id)')

    def test_previous_pair_counts_are_kept_as_originals_but_never_compete_with_new_boards(self):
        storage=Table()
        original={'id':'old-memory-record-001','name':'지우','mode':'memory-easy','durationMs':1000,'moves':6,'pairs':6,'score':0,'correct':6,'total':6,'date':'2026-10-12T00:00:00Z','partnerId':25}
        storage.items['memory-easy']={'mode':'memory-easy','version':1,'entries':[copy.deepcopy(original)]}
        before=copy.deepcopy(storage.items)
        item,entries=handler.board(storage,'memory-easy');self.assertEqual(entries,[]);self.assertEqual(storage.items,before)
        record=handler.parse_submission(self.event(durationMs=12000))
        result=handler.save(storage,record);self.assertEqual(result['rank'],1);self.assertFalse(result.get('keptBest',False))
        self.assertEqual(result['record']['pairs'],8);self.assertEqual(handler.archived_record(storage,'memory-easy',original['id']),original)

    def test_hard_15_pairs_validates_completion_and_preserves_previous_16_pair_records(self):
        for values in [{'pairs':16,'moves':16},{'pairs':15,'moves':14}]:
            with self.assertRaises(handler.RequestError):handler.parse_submission(self.event('memory-hard',**values))
        storage=Table();original={'id':'old-hard-memory-0001','name':'지우','mode':'memory-hard','durationMs':1000,'moves':16,'pairs':16,'score':0,'correct':16,'total':16,'date':'2026-10-19T00:00:00Z','partnerId':25}
        storage.items['memory-hard']={'mode':'memory-hard','version':1,'entries':[copy.deepcopy(original)]}
        before=copy.deepcopy(storage.items);_,entries=handler.board(storage,'memory-hard');self.assertEqual(entries,[]);self.assertEqual(storage.items,before)
        record=handler.parse_submission(self.event('memory-hard',pairs=15,moves=15));result=handler.save(storage,record)
        self.assertEqual(result['rank'],1);self.assertEqual(result['record']['pairs'],15);self.assertEqual(handler.archived_record(storage,'memory-hard',original['id']),original)
