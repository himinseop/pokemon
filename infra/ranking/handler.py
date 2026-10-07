"""Anonymous shared TOP 20 boards, stored atomically in DynamoDB."""
import base64
import json
import os
import random
import re
import unicodedata
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

MODES = ('time-easy', 'time', 'time-hard', 'easy', 'normal', 'hard')
LIMIT = 20
_TABLE = None
NAMES = json.loads((Path(__file__).parent / 'pokemon-names.json').read_text(encoding='utf-8'))


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def response(status, payload):
    return {'statusCode': status, 'headers': {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'},
            'body': json.dumps(payload, ensure_ascii=False, allow_nan=False, default=lambda value: int(value) if isinstance(value, Decimal) else str(value))}


def table():
    global _TABLE
    if _TABLE is None:
        import boto3
        from botocore.config import Config
        _TABLE = boto3.resource('dynamodb', config=Config(connect_timeout=2, read_timeout=2, retries={'max_attempts': 2})).Table(os.environ['TABLE_NAME'])
    return _TABLE


def valid_mode(mode):
    if mode not in MODES:
        raise RequestError(400, '게임과 난이도를 다시 골라줘.')
    return mode


def parse_submission(event):
    body = event.get('body') or ''
    if not isinstance(body, str) or len(body.encode('utf-8')) > 8192:
        raise RequestError(413, '기록이 너무 길어졌어. 새 게임에 도전해볼까?')
    try:
        if event.get('isBase64Encoded'):
            body = base64.b64decode(body, validate=True).decode('utf-8')
        data = json.loads(body, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError):
        raise RequestError(400, '기록을 읽지 못했어. 한 번 더 저장해줘.')
    if not isinstance(data, dict):
        raise RequestError(400, '기록을 확인하지 못했어. 다시 저장해줘.')
    mode = valid_mode(data.get('mode'))
    record_id = data.get('id')
    if not isinstance(record_id, str) or not re.fullmatch(r'[A-Za-z0-9._-]{16,80}', record_id):
        raise RequestError(400, '기록을 확인하지 못했어. 다시 저장해줘.')
    name = data.get('name', '')
    if not isinstance(name, str):
        raise RequestError(400, '이름을 다시 적어줘.')
    name = unicodedata.normalize('NFKC', name).strip()
    if len(name) > 12 or any(unicodedata.category(char).startswith('C') for char in name):
        raise RequestError(400, '이름을 12자 안으로 적어줘.')
    results = data.get('results')
    timed = mode.startswith('time')
    if not isinstance(results, list) or any(type(value) is not bool for value in results):
        raise RequestError(400, '맞힌 문제를 확인하지 못했어. 다시 저장해줘.')
    if (timed and not 1 <= len(results) <= 110) or (not timed and not 1 <= len(results) <= 10):
        raise RequestError(400, '게임이 끝난 뒤에 기록을 남겨줘.')
    correct = sum(results)
    if not correct:
        raise RequestError(400, '한 문제라도 맞히면 랭킹에 이름을 남길 수 있어!')
    score, streak = 0, 0
    for answered in results:
        if not answered:
            streak = 0
            continue
        streak += 1
        score += 100 + min(streak - 1, 10) * 10 if timed else {'easy': 100, 'normal': 200, 'hard': 300}[mode]
    return {'id': record_id, 'name': name, 'mode': mode, 'score': score, 'correct': correct, 'total': len(results)}


def board(storage, mode):
    item = storage.get_item(Key={'mode': mode}, ConsistentRead=True).get('Item')
    return item, list(item.get('entries', [])) if item else []


def sort_key(record):
    return (-record['score'], -record['correct'], record['date'], record['id'])


def save(storage, submitted):
    record = {**submitted, 'date': timestamp()}
    for _ in range(8):
        item, entries = board(storage, record['mode'])
        existing = next((entry for entry in entries if entry['id'] == record['id']), None)
        if existing:
            fields = ['score', 'correct', 'total', 'mode'] + (['name'] if submitted['name'] else [])
            if any(existing[field] != submitted[field] for field in fields):
                raise RequestError(409, '이 기록은 이미 저장됐어. 랭킹에서 확인해봐.')
            return {'qualified': True, 'rank': entries.index(existing) + 1, 'record': existing, 'entries': entries}
        if not record['name']:
            record['name'] = random.choice(NAMES)
        updated = sorted([*entries, record], key=sort_key)[:LIMIT]
        if record not in updated:
            return {'qualified': False, 'rank': None, 'entries': entries}
        version = int(item.get('version', 0)) if item else 0
        kwargs = {'Item': {'mode': record['mode'], 'version': version + 1, 'entries': updated}}
        if item:
            kwargs.update(ConditionExpression='#version = :expected', ExpressionAttributeNames={'#version': 'version'}, ExpressionAttributeValues={':expected': version})
        else:
            kwargs.update(ConditionExpression='attribute_not_exists(#mode)', ExpressionAttributeNames={'#mode': 'mode'})
        try:
            storage.put_item(**kwargs)
            return {'qualified': True, 'rank': updated.index(record) + 1, 'record': record, 'entries': updated}
        except Exception as error:
            if getattr(error, 'response', {}).get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
    raise RequestError(409, '친구의 기록이 먼저 도착했네! 한 번 더 저장해줘.')


def handle(event, context=None, storage=None):
    try:
        headers = {key.lower(): value for key, value in (event.get('headers') or {}).items()}
        origin = headers.get('origin')
        allowed = json.loads(os.environ.get('ALLOWED_ORIGINS', '["https://pokemon.pir.kr"]'))
        if origin and origin not in allowed:
            raise RequestError(403, '여기서는 기록을 남길 수 없어. 게임 화면으로 돌아와줘.')
        method = event.get('requestContext', {}).get('http', {}).get('method')
        path = (event.get('rawPath') or '').rstrip('/')
        if method == 'GET' and path == '/api/rankings':
            mode = valid_mode((event.get('queryStringParameters') or {}).get('mode'))
            _, entries = board(storage if storage is not None else table(), mode)
            return response(200, {'mode': mode, 'entries': entries, 'serverTime': timestamp()})
        if method == 'POST' and path == '/api/scores':
            if not headers.get('content-type', '').lower().startswith('application/json'):
                raise RequestError(415, '기록을 읽지 못했어. 다시 저장해줘.')
            submitted = parse_submission(event)
            return response(200, save(storage if storage is not None else table(), submitted))
        raise RequestError(404, '여기는 찾지 못했어. 게임 화면으로 돌아가볼까?')
    except RequestError as error:
        return response(error.status, {'error': error.message})
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}))
        return response(503, {'error': '랭킹에 연결하지 못했어. 잠깐 뒤에 다시 눌러줘.'})
