import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ranking_handler', ROOT / 'infra/ranking/handler.py')
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)


class Conflict(Exception):
    response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


class Table:
    def __init__(self):
        self.items, self.writes, self.conflict = {}, 0, None
    def get_item(self, Key, ConsistentRead):
        assert ConsistentRead
        return {'Item': copy.deepcopy(self.items[Key['mode']])} if Key['mode'] in self.items else {}
    def put_item(self, **kwargs):
        item = kwargs['Item']; key = item['mode']
        if self.conflict:
            callback, self.conflict = self.conflict, None
            callback(self)
            raise Conflict()
        current = self.items.get(key)
        if current and kwargs.get('ExpressionAttributeValues', {}).get(':expected') != current['version']:
            raise Conflict()
        if not current and kwargs['ConditionExpression'] != 'attribute_not_exists(#mode)':
            raise Conflict()
        self.items[key] = copy.deepcopy(item); self.writes += 1


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
            self.submit(id=f'record-number-{i:08d}', results=[True]*12)
        entries = self.request()[1]['entries']
        self.assertEqual(len(entries), 20)
        self.assertEqual(entries, sorted(entries, key=handler.sort_key))
        before = copy.deepcopy(self.table.items)
        status, data = self.submit(id='below-cutoff-record', results=[True])
        self.assertEqual(status, 200); self.assertFalse(data['qualified']); self.assertEqual(self.table.items, before)
    def test_invalid_requests_do_not_write_to_the_database(self):
        for payload in [{'mode': 'bad'}, {'results': []}, {'results': [1]}, {'results': [False]*10}, {'results': [True]*111}, {'mode': 'hard', 'results': [True]*9}, {'name': 'x'*13}, {'name': 'a\nb'}, {'id': '<bad>'}]:
            self.assertEqual(self.submit(**payload)[0], 400)
        self.assertEqual(self.table.writes, 0)
        self.assertEqual(self.request(mode='not-a-board')[0], 400)
        bad = event(method='POST', path='/api/scores', payload={});bad['body'] = '{bad'
        self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 400)
        bad['body'] = 'x'*8193;self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 413)
        bad = event();bad['headers']['origin'] = 'https://wrong.example';self.assertEqual(handler.handle(bad, storage=self.table)['statusCode'], 403)
    def test_retries_stop_when_the_board_is_continuously_contested(self):
        class Busy(Table):
            def put_item(self, **kwargs): raise Conflict()
        result = handler.handle(event(method='POST',path='/api/scores',payload={'id':'record-number-0001','name':'피카츄','mode':'time','results':[True]}),storage=Busy())
        self.assertEqual(result['statusCode'],409)


if __name__ == '__main__': unittest.main()
