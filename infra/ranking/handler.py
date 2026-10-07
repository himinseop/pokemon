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
        raise RequestError(400, '게임 모드와 난이도를 확인해 주세요.')
    return mode


def parse_submission(event):
    body = event.get('body') or ''
    if not isinstance(body, str) or len(body.encode('utf-8')) > 8192:
        raise RequestError(413, '기록이 너무 커서 저장할 수 없어요.')
    try:
        if event.get('isBase64Encoded'):
            body = base64.b64decode(body, validate=True).decode('utf-8')
        data = json.loads(body, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError):
        raise RequestError(400, '기록을 읽을 수 없어요. 다시 시도해 주세요.')
    if not isinstance(data, dict):
        raise RequestError(400, '기록 형식을 확인해 주세요.')
    mode = valid_mode(data.get('mode'))
    record_id = data.get('id')
    if not isinstance(record_id, str) or not re.fullmatch(r'[A-Za-z0-9._-]{16,80}', record_id):
        raise RequestError(400, '기록 번호를 확인해 주세요.')
    name = data.get('name', '')
    if not isinstance(name, str):
        raise RequestError(400, '트레이너 이름을 확인해 주세요.')
    name = unicodedata.normalize('NFKC', name).strip()
    if len(name) > 12 or any(unicodedata.category(char).startswith('C') for char in name):
        raise RequestError(400, '트레이너 이름은 12자 이내로 적어 주세요.')
    results = data.get('results')
    timed = mode.startswith('time')
    if not isinstance(results, list) or any(type(value) is not bool for value in results):
        raise RequestError(400, '정답 기록을 확인해 주세요.')
    if (timed and not 1 <= len(results) <= 110) or (not timed and not 1 <= len(results) <= 10):
        raise RequestError(400, '완료한 게임 기록만 저장할 수 있어요.')
    correct = sum(results)
    if not correct:
        raise RequestError(400, '정답을 맞힌 뒤 랭킹에 도전해 주세요.')
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
                raise RequestError(409, '이미 다른 내용으로 저장된 기록이에요.')
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
    raise RequestError(409, '다른 기록이 먼저 등록됐어요. 다시 저장해 주세요.')


def handle(event, context=None, storage=None):
    try:
        headers = {key.lower(): value for key, value in (event.get('headers') or {}).items()}
        origin = headers.get('origin')
        allowed = json.loads(os.environ.get('ALLOWED_ORIGINS', '["https://pokemon.pir.kr"]'))
        if origin and origin not in allowed:
            raise RequestError(403, '이 주소에서는 기록을 저장할 수 없어요.')
        method = event.get('requestContext', {}).get('http', {}).get('method')
        path = (event.get('rawPath') or '').rstrip('/')
        if method == 'GET' and path == '/api/rankings':
            mode = valid_mode((event.get('queryStringParameters') or {}).get('mode'))
            _, entries = board(storage if storage is not None else table(), mode)
            return response(200, {'mode': mode, 'entries': entries, 'serverTime': timestamp()})
        if method == 'POST' and path == '/api/scores':
            if not headers.get('content-type', '').lower().startswith('application/json'):
                raise RequestError(415, 'JSON 형식으로 기록을 보내 주세요.')
            submitted = parse_submission(event)
            return response(200, save(storage if storage is not None else table(), submitted))
        raise RequestError(404, '요청한 주소를 찾을 수 없어요.')
    except RequestError as error:
        return response(error.status, {'error': error.message})
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}))
        return response(503, {'error': '랭킹 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'})
