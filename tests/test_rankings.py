import copy
import importlib.util
import json
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ranking_handler', ROOT / 'infra/ranking/handler.py')
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)


class Conflict(Exception):
    response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


class Table:
    def __init__(self):
        self.items, self.writes, self.archive_writes, self.conflict = {}, 0, 0, None
        self.monthly_writes = 0
    def get_item(self, Key, ConsistentRead):
        assert ConsistentRead
        return {'Item': copy.deepcopy(self.items[Key['mode']])} if Key['mode'] in self.items else {}
    def put_item(self, **kwargs):
        item = kwargs['Item']; key = item['mode']
        if key.startswith('history#'):
            if key in self.items: raise Conflict()
            self.items[key] = copy.deepcopy(item); self.archive_writes += 1; return
        if self.conflict:
            callback, self.conflict = self.conflict, None
            callback(self)
            raise Conflict()
        current = self.items.get(key)
        if current and kwargs.get('ExpressionAttributeValues', {}).get(':expected') != current['version']:
            raise Conflict()
        if not current and kwargs['ConditionExpression'] != 'attribute_not_exists(#mode)':
            raise Conflict()
        self.items[key] = copy.deepcopy(item)
        if key.startswith(('month#','personal#')):self.monthly_writes += 1
        else:self.writes += 1


def event(method='GET', path='/api/rankings', payload=None, mode='time-easy'):
    return {'requestContext': {'http': {'method': method}}, 'rawPath': path, 'headers': {'content-type': 'application/json', 'origin': 'https://pokemon.pir.kr'}, 'queryStringParameters': {'mode': mode}, 'body': json.dumps(payload) if payload is not None else None}


class Rankings(unittest.TestCase):
    def setUp(self):
        self.table = Table()
    def request(self, **kwargs):
        result = handler.handle(event(**kwargs), storage=self.table)
        self.assertEqual(result['headers']['cache-control'], 'no-store')
        return result['statusCode'], json.loads(result['body'])
    def submit(self, **overrides):
        payload = {'id': 'record-number-00000001', 'name': '피카츄', 'mode': 'time-easy', 'results': [True, True, False, True]}
        payload.update(overrides)
        return self.request(method='POST', path='/api/scores', payload=payload)
    def test_optional_partner_is_validated_and_kept_with_the_saved_game(self):
        for partner in [None,1,25,1025]:
            with self.subTest(partner=partner):
                status,data=self.submit(id=f'partner-record-{str(partner):0>8}',partnerId=partner)
                self.assertEqual(status,200);self.assertEqual(data['record']['partnerId'],partner)
                self.assertEqual(next(r for r in self.request()[1]['entries'] if r['id']==data['record']['id'])['partnerId'],partner)
        before=copy.deepcopy(self.table.items)
        for partner in [True,False,0,-1,1026,25.5,'25',{},[], 'https://example.com/image.png']:
            status,_=self.submit(id='invalid-partner-0001',partnerId=partner)
            self.assertEqual(status,400);self.assertEqual(self.table.items,before)

    def test_partner_retries_preserve_snapshots_and_old_records_are_not_migrated(self):
        status,data=self.submit(partnerId=25);self.assertEqual(status,200);original=copy.deepcopy(self.table.items)
        self.assertEqual(self.submit(partnerId=25)[1]['record'],data['record']);self.assertEqual(self.table.items,original)
        self.assertEqual(self.submit(partnerId=133)[0],409);self.assertEqual(self.table.items,original)
        self.assertEqual(self.submit()[1]['record'],data['record']);self.assertEqual(self.table.items,original)
        old={'id':'legacy-partner-0001','name':'이슬','mode':'time-easy','score':310,'correct':3,'total':4,'date':'2026-10-01T00:00:00Z'}
        self.table.items['time-easy']['entries'].append(old);snapshot=copy.deepcopy(self.table.items)
        self.request();self.assertEqual(self.table.items,snapshot)
        status,result=self.submit(id=old['id'],name=old['name'],partnerId=None)
        self.assertEqual(status,200);self.assertEqual(result['record'],old);self.assertNotIn('partnerId',result['record'])
        for key,row in snapshot.items():
            if not key.startswith(('month#','personal#')):self.assertEqual(self.table.items[key],row)
        self.assertEqual(handler.archived_record(self.table,'time-easy',old['id']),old)

    def test_each_name_keeps_one_highest_record_and_equal_scores_use_the_new_attempt(self):
        first=self.submit(id='best-record-first-001',name='지우',results=[True]*3)[1]['record']
        before=copy.deepcopy(self.table.items);writes=self.table.writes
        status,data=self.submit(id='best-record-lower-001',name='지우',results=[True])
        self.assertEqual(status,200);self.assertTrue(data['keptBest']);self.assertEqual(data['record'],first)
        self.assertEqual(self.table.items['time-easy'],before['time-easy']);self.assertEqual(self.table.writes,writes)
        self.assertEqual(handler.archived_record(self.table,'time-easy','best-record-lower-001')['score'],100)
        higher=self.submit(id='best-record-higher-01',name='지우',results=[True]*4)[1]['record']
        self.assertEqual(len(self.request()[1]['entries']),1);self.assertEqual(higher['score'],460)
        equal=self.submit(id='best-record-equal-001',name=' 지우 ',results=[True]*4)[1]['record']
        self.assertEqual(equal['id'],'best-record-equal-001');self.assertEqual(self.request()[1]['entries'],[equal])
        self.assertEqual(self.submit(id=equal['id'],name='지우',results=[True]*4)[1]['record'],equal)
        self.submit(id='best-record-sibling1',name='이슬',results=[True]*2)
        self.assertEqual(len(self.request()[1]['entries']),2)
        self.submit(id='best-record-othermod',name='지우',mode='hard',results=[True])
        self.assertEqual(len(self.request(mode='hard')[1]['entries']),1)

    def test_legacy_duplicates_are_hidden_without_any_read_time_database_writes(self):
        high={'id':'legacy-highest-001','name':'Mina','mode':'easy','score':300,'correct':3,'total':3,'date':'2026-10-07T00:00:00Z'}
        lower={**high,'id':'legacy-lower-0001','name':' Ｍｉｎａ ','score':100,'correct':1,'total':1}
        newer={**high,'id':'legacy-newest-001','name':'mina','date':'2026-10-08T00:00:00Z'}
        self.table.items['easy']={'mode':'easy','version':9,'entries':[lower,high,newer]};before=copy.deepcopy(self.table.items)
        self.assertEqual(self.request(mode='easy')[1]['entries'],[newer]);self.assertEqual(self.table.items,before);self.assertEqual(self.table.writes,0)
        parsed=handler.parse_submission(event(method='POST',path='/api/scores',payload={'id':lower['id'],'name':'Mina','mode':'easy','results':[True]}))
        # An exact retry of a hidden older record must resolve to the winner.
        parsed['name']=lower['name']
        result=handler.save(self.table,parsed);self.assertEqual(result['record'],newer);self.assertTrue(result['keptBest']);self.assertEqual(self.table.items,before)

    def test_concurrent_higher_score_wins_without_losing_another_trainer(self):
        first=self.submit(id='initial-best-record1',name='지우',results=[True])[1]['record']
        other={**first,'id':'other-best-record001','name':'이슬','score':200}
        higher={**first,'id':'racing-best-record01','score':1000}
        def race(table):table.items['time-easy']={'mode':'time-easy','version':2,'entries':[higher,other]}
        self.table.conflict=race
        result=self.submit(id='racing-lower-record1',name='지우',results=[True]*3)[1]
        self.assertTrue(result['keptBest']);self.assertEqual(result['record'],higher);self.assertEqual([r['name'] for r in result['entries']],['지우','이슬'])

    def test_device_context_uses_verified_grant_and_is_not_public_or_client_supplied(self):
        import types
        from unittest.mock import Mock
        token='a'*32+'.'+'b'*43;verify=Mock(return_value={'deviceId':'a'*32})
        fake_access=types.SimpleNamespace(require_device=verify)
        request=event(method='POST',path='/api/scores',payload={'id':'device-record-000001','name':'지우','mode':'time-easy','results':[True],'deviceId':'forged','userAgent':'forged'})
        request['headers'].update({'x-device-key':token,'user-agent':'Safari '+ 'x'*300,'x-preview-device-id':'c'*32})
        with patch.dict('sys.modules',{'access':fake_access}),patch.dict('os.environ',{'AUTH_REQUIRED':'1'}):
            result=handler.handle(request,storage=self.table,access_storage='verified-storage')
            self.assertEqual(result['statusCode'],200);verify.assert_called_once_with(token,'verified-storage')
            stored=self.table.items['time-easy']['entries'][0];self.assertEqual(stored['deviceId'],'a'*32);self.assertEqual(len(stored['userAgent']),240)
            public=json.loads(result['body']);self.assertNotIn('deviceId',public['record']);self.assertNotIn('userAgent',public['entries'][0]);self.assertNotIn(token,result['body'])
            got=handler.handle(event(),storage=self.table,access_storage='verified-storage')
            self.assertNotIn('deviceId',json.loads(got['body'])['entries'][0])
        original=copy.deepcopy(stored)
        self.submit(id=stored['id'],name='지우',results=[True]);self.assertEqual(self.table.items['time-easy']['entries'][0],original)

    def test_grouping_archives_every_original_row_before_replacing_the_board(self):
        old={'id':'archive-original-001','name':'지우','mode':'easy','score':100,'correct':1,'total':1,'date':'2026-10-01T00:00:00Z','deviceId':'old-device','userAgent':'Old browser','partnerId':25}
        duplicate={**old,'id':'archive-duplicate-01','score':200,'correct':2,'total':2}
        friend={**old,'id':'archive-friend-0001','name':'이슬','partnerId':7}
        self.table.items['easy']={'mode':'easy','version':3,'entries':[old,duplicate,friend],'legacyNote':'keep this too'}
        result=self.submit(id='archive-new-best001',name='지우',mode='easy',results=[True]*3)[1]
        self.assertEqual(len(result['entries']),2);self.assertEqual(self.table.items['easy']['legacyNote'],'keep this too')
        for original in [old,duplicate,friend]:self.assertEqual(handler.archived_record(self.table,'easy',original['id']),original)
        self.assertIsNotNone(handler.archived_record(self.table,'easy','archive-new-best001'))
        self.assertEqual(len(self.table.items['easy']['archivedIds']),2)

    def test_archive_failure_never_discards_original_board_and_retry_succeeds(self):
        original={'id':'backup-failure-old1','name':'지우','mode':'easy','score':100,'correct':1,'total':1,'date':'2026-10-01T00:00:00Z'}
        self.table.items['easy']={'mode':'easy','version':1,'entries':[original]};before=copy.deepcopy(self.table.items['easy'])
        real_put=self.table.put_item;failed=False
        def fail_once(**kwargs):
            nonlocal failed
            if kwargs['Item']['mode']==handler.history_key('easy',original['id']) and not failed:
                failed=True;raise RuntimeError('archive unavailable')
            return real_put(**kwargs)
        with patch.object(self.table,'put_item',side_effect=fail_once):
            self.assertEqual(self.submit(id='backup-failure-new1',name='지우',mode='easy',results=[True]*3)[0],503)
            self.assertEqual(self.table.items['easy'],before)
            result=self.submit(id='backup-failure-new1',name='지우',mode='easy',results=[True]*3)[1]
            self.assertEqual(result['record']['score'],300)
        self.assertEqual(handler.archived_record(self.table,'easy',original['id']),original)

    def test_history_keeps_more_than_twenty_attempts_without_growing_the_board_item(self):
        for i in range(30):self.submit(id=f'archive-attempt-{i:04d}',name='지우',results=[True]*(i+1))
        self.assertEqual(len(self.request()[1]['entries']),1)
        self.assertEqual(len([key for key in self.table.items if key.startswith('history#')]),30)
        old=copy.deepcopy(handler.archived_record(self.table,'time-easy','archive-attempt-0000'))
        result=self.submit(id='archive-attempt-0000',name='지우',results=[True])[1]
        self.assertTrue(result['keptBest']);self.assertEqual(result['record']['id'],'archive-attempt-0029')
        self.assertEqual(handler.archived_record(self.table,'time-easy','archive-attempt-0000'),old)
        self.assertEqual(self.submit(id='archive-attempt-0000',name='지우',results=[True]*2)[0],409)
        self.assertEqual(len(self.table.items['time-easy']['archivedIds']),1)

    def test_archived_record_survives_board_eviction_and_is_hidden_from_public_mode_queries(self):
        first=self.submit(id='evicted-original001',name='지우',results=[True])[1]['record']
        for i in range(20):self.submit(id=f'evicting-friend-{i:03d}',name=f'친구{i}',results=[True]*5)
        self.assertNotIn(first['id'],[row['id'] for row in self.request()[1]['entries']])
        self.assertEqual(handler.public_result({'record':handler.archived_record(self.table,'time-easy',first['id'])})['record'],first)
        self.assertEqual(self.request(mode=handler.history_key('time-easy',first['id']))[0],400)

    def test_empty_boards_and_modes_are_independent(self):
        for mode in handler.MODES:
            status, data = self.request(mode=mode)
            self.assertEqual(status, 200); self.assertEqual(data['mode'], mode); self.assertEqual(data['entries'], [])
        self.submit()
        self.assertEqual(len(self.request(mode='time-easy')[1]['entries']), 1)
        self.assertEqual(self.request(mode='hard')[1]['entries'], [])
    def test_score_is_derived_from_results_not_an_arbitrary_client_score(self):
        status, data = self.submit(score=999999, date='2099-01-01T00:00:00Z')
        self.assertEqual(status, 200); self.assertTrue(data['qualified'])
        self.assertEqual(data['record']['score'], 310); self.assertEqual(data['record']['correct'], 3)
        self.assertEqual(data['record']['total'], 4); self.assertNotEqual(data['record']['date'], '2099-01-01T00:00:00Z')
        for mode, unit in [('easy', 100), ('normal', 200), ('hard', 300)]:
            record = self.submit(mode=mode, results=[True]*8+[False]*2)[1]['record']
            self.assertEqual(record['score'], unit*8)
    def test_quitting_master_keeps_only_answered_questions_and_earned_points(self):
        status, data = self.submit(mode='hard', results=[True, False, True])
        self.assertEqual(status, 200)
        self.assertEqual(data['record']['score'], 600)
        self.assertEqual(data['record']['total'], 3)
        self.assertEqual(data['record']['correct'], 2)
    def test_master_hint_penalty_is_calculated_by_server_for_each_difficulty(self):
        for mode, unit in [('easy', 100), ('normal', 200), ('hard', 300)]:
            status, data = self.submit(mode=mode, results=[True, True, False], hints=[True, False, True], score=999999)
            self.assertEqual(status, 200)
            self.assertEqual(data['record']['score'], unit * 3 // 2)
            self.assertEqual(data['record']['hintsUsed'], 2)
            self.assertEqual(data['record']['correct'], 2)
    def test_master_time_bonus_matches_elapsed_time_and_ignores_hints_and_misses(self):
        for mode, unit in [('easy', 100), ('normal', 200), ('hard', 300)]:
            status, data = self.submit(mode=mode, results=[True, True, True, True, False], hints=[False, False, False, True, False], elapsedMs=[0, 10000, 20000, 0, 0], score=999999)
            self.assertEqual(status, 200)
            bonus=unit//2 + ((unit//4 + 9)//10)*10
            self.assertEqual(data['record']['timeBonus'], bonus)
            self.assertEqual(data['record']['score'], unit*3+unit//2+bonus)
    def test_bonus_step_boundaries_match_each_difficulty(self):
        for mode,maximum,boundary in [('easy',50,4000),('normal',100,2000),('hard',150,1334)]:
            for elapsed,expected in [(0,maximum),(boundary-1,maximum),(boundary,maximum-10),(19999,10),(20000,0)]:
                payload={'id':'bonus-boundary-000001','name':'지우','mode':mode,'results':[True],'elapsedMs':[elapsed]}
                record=handler.parse_submission(event(method='POST',path='/api/scores',payload=payload))
                self.assertEqual(record['timeBonus'],expected)
    def test_invalid_bonus_arrays_do_not_write_and_time_attack_cannot_claim_master_bonus(self):
        for elapsed in [None, {}, [0], [True]*4, [0.5]*4, [-1]*4, [20001]*4]:
            self.assertEqual(self.submit(mode='easy', elapsedMs=elapsed)[0], 400)
        self.assertEqual(self.submit(elapsedMs=[0]*4)[0], 400)
        self.assertEqual(self.table.writes, 0)
    def test_bonus_submission_is_idempotent_and_cannot_change_an_existing_score(self):
        first = self.submit(mode='hard', results=[True], elapsedMs=[0])[1]['record']
        self.assertEqual(first['score'], 450)
        self.assertEqual(self.submit(mode='hard', results=[True], elapsedMs=[0])[1]['record'], first)
        self.assertEqual(self.submit(mode='hard', results=[True], elapsedMs=[20000])[0], 409)
        self.assertEqual(self.table.writes, 1)
    def test_legacy_master_submission_and_retry_have_no_time_bonus(self):
        record = self.submit(mode='hard', results=[True])[1]['record']
        self.assertEqual(record['score'], 300)
        self.assertEqual(record['timeBonus'], 0)
        self.table.items['hard']['entries'][0].pop('timeBonus')
        self.assertEqual(self.submit(mode='hard', results=[True])[0], 200)
        self.assertEqual(self.table.writes, 1)
    def test_invalid_hint_arrays_and_time_attack_hints_do_not_write(self):
        for hints in [None, {}, [True], [1, False, False, False], [True, False, False, False]]:
            self.assertEqual(self.submit(hints=hints)[0], 400)
        self.assertEqual(self.submit(mode='easy', results=[True], hints=[False, True])[0], 400)
        self.assertEqual(self.table.writes, 0)
    def test_legacy_records_without_hint_metadata_remain_idempotent(self):
        first = self.submit()[1]['record']
        self.table.items['time-easy']['entries'][0].pop('hintsUsed')
        status, again = self.submit()
        self.assertEqual(status, 200)
        self.assertEqual(again['record']['id'], first['id'])
        self.assertEqual(self.table.writes, 1)
    def test_duplicate_submission_is_idempotent_and_cannot_rename_another_record(self):
        first = self.submit()[1]
        again = self.submit()[1]
        self.assertEqual(first['record'], again['record']); self.assertEqual(self.table.writes, 1)
        self.assertEqual(self.submit(name='이브이')[0], 409)
        self.assertEqual(self.table.writes, 1)
    def test_blank_name_gets_a_pokemon_name_and_stays_the_same_when_retried(self):
        first = self.submit(name=' ')[1]['record']
        self.assertIn(first['name'], handler.NAMES)
        self.assertEqual(self.submit(name=' ')[1]['record'], first)
    def test_concurrent_write_does_not_lose_the_other_player(self):
        other = {'id': 'competing-record-0001', 'name': '이브이', 'mode': 'time-easy', 'score': 1000, 'correct': 8, 'total': 10, 'date': '2026-01-01T00:00:00.000Z'}
        self.table.conflict = lambda table: table.items.update({'time-easy': {'mode': 'time-easy', 'version': 1, 'entries': [other]}})
        status, data = self.submit()
        self.assertEqual(status, 200); self.assertEqual(data['rank'], 2)
        self.assertEqual([r['id'] for r in data['entries']], ['competing-record-0001', 'record-number-00000001'])
        self.assertEqual(self.table.items['time-easy']['version'], 2)
    def test_board_retains_twenty_and_rejects_scores_below_the_cutoff(self):
        for i in range(25):
            self.submit(id=f'record-number-{i:08d}', name=f'트레이너{i}', results=[True]*12)
        entries = self.request()[1]['entries']
        self.assertEqual(len(entries), 20)
        self.assertEqual(entries, sorted(entries, key=handler.sort_key))
        before = copy.deepcopy(self.table.items)
        status, data = self.submit(id='below-cutoff-record', results=[True])
        self.assertEqual(status, 200); self.assertFalse(data['qualified']); self.assertEqual(self.table.items['time-easy'], before['time-easy']);self.assertIsNotNone(handler.archived_record(self.table,'time-easy','below-cutoff-record'))
    def test_existing_ties_are_read_newest_first_without_rewriting_the_board(self):
        older = {'id': 'older-record-0001', 'name': '이브이', 'mode': 'easy', 'score': 100, 'correct': 2, 'total': 3, 'date': '2026-10-07T00:00:00.000Z'}
        newer = {**older, 'id': 'newer-record-0001', 'name': '뮤', 'correct': 1, 'date': '2026-10-07T01:00:00.000Z'}
        self.table.items['easy'] = {'mode': 'easy', 'version': 1, 'entries': [older, newer]}
        status, data = self.request(mode='easy')
        self.assertEqual(status, 200)
        self.assertEqual([r['id'] for r in data['entries']], [newer['id'], older['id']])
        self.assertEqual(self.table.writes, 0)
    def test_new_tie_enters_full_board_first_and_retry_returns_the_same_rank(self):
        self.table.items['easy'] = {'mode': 'easy', 'version': 1, 'entries': [
            {'id': f'older-record-{i:08d}', 'name': f'이브이{i}', 'mode': 'easy', 'score': 100, 'correct': 2, 'total': 3, 'date': f'2026-10-07T00:00:{i:02d}.000Z'} for i in range(20)
        ]}
        with patch.object(handler, 'timestamp', return_value='2026-10-07T01:00:00.000Z'):
            status, data = self.submit(mode='easy', results=[True])
        self.assertEqual(status, 200)
        self.assertTrue(data['qualified'])
        self.assertEqual(data['rank'], 1)
        self.assertEqual(len(data['entries']), 20)
        self.assertNotIn('older-record-00000000', [r['id'] for r in data['entries']])
        again = self.submit(mode='easy', results=[True])[1]
        self.assertEqual(again['rank'], 1)
        self.assertEqual(again['record'], data['record'])
        self.assertEqual(self.table.writes, 1)
    def test_invalid_requests_do_not_write_to_the_database(self):
        for payload in [{'mode': 'bad'}, {'results': []}, {'results': [1]}, {'results': [False]*10}, {'results': [True]*111}, {'mode': 'hard', 'results': [True]*11}, {'name': 'x'*13}, {'name': 'a\nb'}, {'id': '<bad>'}]:
            self.assertEqual(self.submit(**payload)[0], 400)
        self.assertEqual(self.table.writes, 0)
        self.assertEqual(self.request(mode='not-a-board')[0], 400)
        bad = event(method='POST', path='/api/scores', payload={});bad['body'] = '{bad'
        self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 400)
        bad['body'] = 'x'*8193;self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 413)
        bad = event();bad['headers']['origin'] = 'https://wrong.example';self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 403)
    def test_retries_stop_when_the_board_is_continuously_contested(self):
        class Busy(Table):
            def put_item(self, **kwargs):
                if kwargs['Item']['mode'].startswith('history#'):return super().put_item(**kwargs)
                raise Conflict()
        result = handler.handle(event(method='POST',path='/api/scores',payload={'id':'record-number-0001','name':'피카츄','mode':'time','results':[True]}),storage=Busy())
        self.assertEqual(result['statusCode'],409)


if __name__ == '__main__': unittest.main()
