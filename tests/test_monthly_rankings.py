import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from test_rankings import handler, Table, Conflict, event


class MonthlyRankings(unittest.TestCase):
    def record(self, ident='monthly-record-00001', name='지우', results=3, mode='time-easy'):
        return handler.parse_submission(event(method='POST', path='/api/scores', payload={
            'id':ident, 'name':name, 'mode':mode, 'results':[True]*results}))

    def saved(self, storage, date, **kwargs):
        with patch.object(handler, 'timestamp', return_value=date):
            return handler.save_with_monthly(storage, self.record(**kwargs), True)

    def test_korean_month_boundary_and_strict_month_validation(self):
        self.assertEqual(handler.ranking_month('2026-09-30T14:59:59Z'), '2026-09')
        self.assertEqual(handler.ranking_month('2026-09-30T15:00:00Z'), '2026-10')
        self.assertEqual(handler.ranking_month('2026-12-31T15:00:00Z'), '2027-01')
        for month in ['', '2026-1', '2026-00', '2026-13', '../2026-10', None]:
            with self.subTest(month=month), self.assertRaises(handler.RequestError):handler.valid_month(month)

    def test_new_month_keeps_its_own_best_even_below_the_lifetime_best(self):
        storage=Table()
        old=self.saved(storage,'2026-09-20T00:00:00Z',results=5)
        now=self.saved(storage,'2026-10-01T00:00:00Z',ident='monthly-record-00002',results=1)
        self.assertEqual(old['month'],'2026-09');self.assertEqual(now['month'],'2026-10')
        self.assertEqual(now['record']['score'],100)
        self.assertEqual(handler.board(storage,'time-easy')[1][0]['score'],600)
        self.assertEqual(handler.board(storage,'time-easy','2026-09')[1],[old['record']])
        self.assertEqual(handler.board(storage,'time-easy','2026-10')[1],[now['record']])
        self.assertIsNotNone(handler.archived_record(storage,'time-easy','monthly-record-00002'))

    def test_monthly_top_twenty_groups_names_and_recent_ties_win(self):
        storage=Table()
        first=self.saved(storage,'2026-10-01T00:00:00Z',name=' Ｍｉｎａ ')
        equal=self.saved(storage,'2026-10-02T00:00:00Z',ident='monthly-record-00002',name='mina')
        self.assertEqual(equal['record']['id'],'monthly-record-00002')
        lower=self.saved(storage,'2026-10-03T00:00:00Z',ident='monthly-record-00003',name='Mina',results=1)
        self.assertTrue(lower['keptBest']);self.assertEqual(lower['record'],equal['record'])
        for n in range(25):
            self.saved(storage,'2026-10-03T00:00:00Z',ident=f'monthly-friend-{n:05}',name=f'친구{n}',results=4)
        self.assertEqual(len(handler.board(storage,'time-easy','2026-10')[1]),20)
        for ident in [first['record']['id'],equal['record']['id'],'monthly-record-00003']:
            self.assertIsNotNone(handler.archived_record(storage,'time-easy',ident))

    def test_legacy_month_read_is_read_only_and_filters_before_name_grouping(self):
        storage=Table();october={**self.record(),'score':100,'date':'2026-10-01T00:00:00Z'}
        september={**october,'id':'previous-month-00001','score':999,'date':'2026-09-01T00:00:00Z'}
        storage.items['time-easy']={'mode':'time-easy','version':8,'entries':[september,october],'keep':'legacy metadata'}
        before=copy.deepcopy(storage.items)
        self.assertEqual(handler.board(storage,'time-easy','2026-10')[1],[october])
        self.assertEqual(handler.board(storage,'time-easy','2026-09')[1],[september])
        self.assertEqual(handler.board(storage,'time-easy','2026-08')[1],[])
        self.assertEqual(storage.items,before);self.assertEqual(storage.writes,0)

    def test_monthly_failure_retry_keeps_the_original_month_and_record(self):
        class FailureTable(Table):
            fail=True
            def put_item(self,**kwargs):
                if kwargs['Item']['mode'].startswith('month#') and self.fail:
                    self.fail=False;raise RuntimeError('temporarily unavailable')
                return super().put_item(**kwargs)
        storage=FailureTable();record=self.record()
        with patch.object(handler,'timestamp',return_value='2026-09-30T14:59:59Z'),self.assertRaises(RuntimeError):
            handler.save_with_monthly(storage,record,True)
        original=handler.archived_record(storage,'time-easy',record['id'])
        with patch.object(handler,'timestamp',return_value='2026-09-30T15:00:01Z'):
            result=handler.save_with_monthly(storage,record,True)
        self.assertEqual(result['month'],'2026-09');self.assertEqual(result['record'],original)
        before=copy.deepcopy(storage.items)
        handler.save_with_monthly(storage,record,True)
        self.assertEqual(storage.items,before)

    def test_monthly_conflict_retries_without_losing_a_friend(self):
        storage=Table();original={**self.record(),'date':'2026-10-01T00:00:00Z'}
        friend={**original,'id':'monthly-friend-00001','name':'이슬','score':999}
        def race(table):table.items['month#2026-10#time-easy']={'mode':'month#2026-10#time-easy','version':1,'entries':[friend]}
        storage.conflict=race
        result=handler.save_monthly_record(storage,original)
        self.assertEqual([r['name'] for r in result['entries']],['이슬','지우'])

    def test_api_month_is_validated_and_submission_cannot_choose_a_past_month(self):
        storage=Table();request=event();request['queryStringParameters']['month']='2026-13'
        self.assertEqual(handler.handle(request,storage=storage)['statusCode'],400)
        self.assertEqual(storage.items,{})
        request=event(method='POST',path='/api/scores',payload={'id':'monthly-record-00001','name':'지우','mode':'time-easy','results':[True]})
        request['queryStringParameters']['month']='2026-09'
        with patch.object(handler,'timestamp',return_value='2026-10-01T00:00:00Z'):
            response=handler.handle(request,storage=storage)
        data=json.loads(response['body']);self.assertEqual(response['statusCode'],200);self.assertEqual(data['month'],'2026-10')
        self.assertNotIn('month#2026-09#time-easy',storage.items)
        query=event();query['queryStringParameters']['month']='2026-10'
        before=copy.deepcopy(storage.items)
        self.assertEqual(json.loads(handler.handle(query,storage=storage)['body'])['entries'][0]['id'],'monthly-record-00001')
        self.assertEqual(storage.items,before)

    def test_memory_months_keep_shortest_time_and_old_card_counts_are_preserved(self):
        storage=Table()
        for month,ident,duration in [('09','old-memory-month-01',1000),('10','new-memory-month-01',5000)]:
            record=handler.parse_submission(event(method='POST',path='/api/scores',payload={'id':ident,'name':'지우','mode':'memory-hard','pairs':15,'moves':15,'durationMs':duration}))
            with patch.object(handler,'timestamp',return_value=f'2026-{month}-01T00:00:00Z'):handler.save_with_monthly(storage,record,True)
        self.assertEqual(handler.board(storage,'memory-hard','2026-10')[1][0]['durationMs'],5000)
        self.assertEqual(handler.board(storage,'memory-hard')[1][0]['durationMs'],1000)

    def test_backfill_recovers_archived_months_idempotently_without_replacing_originals(self):
        path=Path(__file__).resolve().parents[1]/'scripts/backfill-monthly-rankings.py'
        spec=importlib.util.spec_from_file_location('backfill',path);backfill=importlib.util.module_from_spec(spec);spec.loader.exec_module(backfill)
        storage=Table();september={**self.record(),'date':'2026-09-01T00:00:00Z'}
        october={**september,'id':'monthly-record-00002','score':100,'date':'2026-10-01T00:00:00Z'}
        handler.archive_record(storage,october)
        storage.items['time-easy']={'mode':'time-easy','version':3,'entries':[september],'privateNote':'preserve'}
        before=copy.deepcopy(storage.items);items=list(storage.items.values())
        plan=backfill.recover(storage,items);self.assertEqual(plan['months'],2);self.assertEqual(storage.items,before)
        backfill.recover(storage,items,True)
        for key,row in before.items():self.assertEqual(storage.items[key],row)
        self.assertEqual(handler.board(storage,'time-easy','2026-10')[1],[october])
        after=copy.deepcopy(storage.items);backfill.recover(storage,list(storage.items.values()),True);self.assertEqual(storage.items,after)

    def test_personal_best_survives_month_changes_and_falling_outside_top_twenty(self):
        storage=Table()
        first=self.saved(storage,'2026-09-01T00:00:00Z',results=1)['record']
        for n in range(21):self.saved(storage,'2026-10-01T00:00:00Z',ident=f'personal-friend-{n:04}',name=f'친구{n}',results=5)
        self.assertNotIn(first,handler.board(storage,'time-easy')[1])
        self.assertEqual(handler.personal_best(storage,'time-easy','지우'),first)
        improved=self.saved(storage,'2026-10-02T00:00:00Z',ident='personal-improved-01',results=2)['qualified']
        self.assertFalse(improved)
        self.assertEqual(handler.personal_best(storage,'time-easy','지우')['score'],210)
        self.assertIsNotNone(handler.archived_record(storage,'time-easy',first['id']))

    def test_personal_best_api_hides_device_context_and_reads_without_writes(self):
        storage=Table();record={**self.record(),'date':'2026-09-01T00:00:00Z','deviceId':'private-device','userAgent':'private-browser'}
        handler.save_personal_best(storage,record);before=copy.deepcopy(storage.items)
        request=event();request['queryStringParameters'].update(month='2026-10',trainer='지우')
        data=json.loads(handler.handle(request,storage=storage)['body'])
        self.assertEqual(data['personalBest']['id'],record['id']);self.assertNotIn('deviceId',data['personalBest']);self.assertNotIn('userAgent',data['personalBest'])
        self.assertEqual(storage.items,before)
        request['queryStringParameters']['trainer']='x'*13
        self.assertEqual(handler.handle(request,storage=storage)['statusCode'],400)

    def test_memory_personal_best_is_separate_for_each_card_count(self):
        storage=Table();record={'id':'personal-memory-0001','name':'지우','mode':'memory-hard','score':0,'correct':16,'total':16,'pairs':16,'moves':16,'durationMs':1000,'date':'2026-09-01T00:00:00Z'}
        handler.save_personal_best(storage,record)
        self.assertIsNone(handler.personal_best(storage,'memory-hard','지우'))
        new={**record,'id':'personal-memory-0002','pairs':15,'moves':15,'correct':15,'total':15,'durationMs':5000,'date':'2026-10-01T00:00:00Z'}
        handler.save_personal_best(storage,new);self.assertEqual(handler.personal_best(storage,'memory-hard','지우'),new)
        self.assertEqual(storage.items[handler.personal_key('memory-hard','지우',16)]['record'],record)
