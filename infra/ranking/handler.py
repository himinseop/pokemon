"""Anonymous shared TOP 20 boards, stored atomically in DynamoDB."""
import base64
import hashlib
import json
import os
import random
import re
import unicodedata
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path

MODES = ('time-easy', 'time', 'time-hard', 'easy', 'normal', 'hard', 'memory-easy', 'memory-normal', 'memory-hard')
LIMIT = 20
BONUS_DURATION = 20000
KST = timezone(timedelta(hours=9))
_TABLE = None
NAMES = json.loads((Path(__file__).parent / 'pokemon-names.json').read_text(encoding='utf-8'))


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def ranking_month(date=None):
    moment = datetime.fromisoformat(date.replace('Z', '+00:00')) if date else datetime.now(timezone.utc)
    return moment.astimezone(KST).strftime('%Y-%m')


def valid_month(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{3}-(0[1-9]|1[0-2])', value):
        raise RequestError(400, '순위를 보고 싶은 달을 다시 골라줘.')
    return value


def monthly_key(mode, month):
    return f'month#{valid_month(month)}#{mode}'


def response(status, payload, cookies=None):
    result = {'statusCode': status, 'headers': {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'},
            'body': json.dumps(payload, ensure_ascii=False, allow_nan=False, default=lambda value: int(value) if isinstance(value, Decimal) else str(value))}
    if cookies is not None: result['cookies'] = cookies
    return result


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
    if mode.startswith('memory-'):
        duration, moves = data.get('durationMs'), data.get('moves')
        pairs = {'memory-easy':8,'memory-normal':12,'memory-hard':15}[mode]
        if type(data.get('pairs')) is not int or data.get('pairs') != pairs or type(duration) is not int or not 1 <= duration <= 86400000 or type(moves) is not int or not pairs <= moves <= 10000:
            raise RequestError(400, '모든 카드의 짝을 맞힌 뒤 기록을 남겨줘.')
        record = {'id':record_id,'name':name,'mode':mode,'durationMs':duration,'moves':moves,'pairs':pairs,'score':0,'correct':pairs,'total':pairs}
        partner = data.get('partnerId')
        if partner is not None and (type(partner) is not int or not 1 <= partner <= len(NAMES)):
            raise RequestError(400, '파트너 포켓몬을 다시 골라줘.')
        if 'partnerId' in data:record['partnerId']=partner
        return record
    results = data.get('results')
    timed = mode.startswith('time')
    if not isinstance(results, list) or any(type(value) is not bool for value in results):
        raise RequestError(400, '맞힌 문제를 확인하지 못했어. 다시 저장해줘.')
    if (timed and not 1 <= len(results) <= 110) or (not timed and not 1 <= len(results) <= 10):
        raise RequestError(400, '게임이 끝난 뒤에 기록을 남겨줘.')
    hints = data.get('hints', [False] * len(results))
    if not isinstance(hints, list) or len(hints) != len(results) or any(type(value) is not bool for value in hints) or (timed and any(hints)):
        raise RequestError(400, '힌트를 쓴 문제를 확인하지 못했어. 다시 저장해줘.')
    elapsed = data.get('elapsedMs', [BONUS_DURATION] * len(results))
    if not isinstance(elapsed, list) or len(elapsed) != len(results) or any(type(value) is not int or not 0 <= value <= BONUS_DURATION for value in elapsed) or (timed and 'elapsedMs' in data):
        raise RequestError(400, '보너스 시간을 확인하지 못했어. 다시 저장해줘.')
    correct = sum(results)
    if not correct:
        raise RequestError(400, '한 문제라도 맞히면 순위에 이름을 남길 수 있어!')
    score, streak, time_bonus = 0, 0, 0
    for answered, hinted, duration in zip(results, hints, elapsed):
        if not answered:
            streak = 0
            continue
        streak += 1
        if timed:
            score += 100 + min(streak - 1, 10) * 10
        else:
            unit = {'easy': 100, 'normal': 200, 'hard': 300}[mode]
            maximum = unit // 2
            bonus = 0 if hinted else maximum - duration * maximum // (BONUS_DURATION * 10) * 10
            score += unit // (2 if hinted else 1) + bonus
            time_bonus += bonus
    record = {'id': record_id, 'name': name, 'mode': mode, 'score': score, 'correct': correct, 'total': len(results), 'hintsUsed': sum(hints), 'timeBonus': time_bonus}
    if 'partnerId' in data:
        partner = data['partnerId']
        if partner is not None and (type(partner) is not int or not 1 <= partner <= len(NAMES)):
            raise RequestError(400, '파트너 포켓몬을 다시 골라줘.')
        record['partnerId'] = partner
    return record


def board(storage, mode, month=None):
    item = storage.get_item(Key={'mode': monthly_key(mode, month) if month else mode}, ConsistentRead=True).get('Item')
    entries = item.get('entries', []) if item else []
    if month:
        # Existing boards remain untouched; migration can add archived originals later.
        legacy = storage.get_item(Key={'mode': mode}, ConsistentRead=True).get('Item', {})
        entries = list({row['id']:row for row in [*legacy.get('entries', []), *entries]
                        if row.get('mode') == mode and ranking_month(row['date']) == month}.values())
    if mode.startswith('memory-'):
        pairs = {'memory-easy':8,'memory-normal':12,'memory-hard':15}[mode]
        entries = [row for row in entries if row.get('pairs') == pairs]
    return item, best_entries(entries)[:LIMIT] if month else best_entries(entries)


def trainer_key(record):
    name = unicodedata.normalize('NFKC', record.get('name', '')).strip().lower()
    return ('name', name) if name else ('record', record['id'])


def best_entries(records):
    seen, entries = set(), []
    for record in sorted(records, key=sort_key):
        key = trainer_key(record)
        if key not in seen:
            seen.add(key)
            entries.append(record)
    return entries


def public_result(data):
    # Device context stays in storage for future administration, never in the
    # shared leaderboard or save acknowledgement (and never stores a device key).
    public_record = lambda row: {key: value for key, value in row.items() if key not in ('deviceId', 'userAgent')}
    result = dict(data)
    if 'entries' in result: result['entries'] = [public_record(row) for row in result['entries']]
    if 'record' in result: result['record'] = public_record(result['record'])
    if result.get('personalBest'): result['personalBest'] = public_record(result['personalBest'])
    return result


def sort_key(record):
    value = record['durationMs'] if record['mode'].startswith('memory-') else -record['score']
    return (value, -datetime.fromisoformat(record['date'].replace('Z', '+00:00')).timestamp(), record['id'])


def performance_value(record):
    return -record['durationMs'] if record['mode'].startswith('memory-') else record['score']


def history_key(mode, record_id):
    return f'history#{mode}#{record_id}'


def archived_record(storage, mode, record_id):
    return storage.get_item(Key={'mode': history_key(mode, record_id)}, ConsistentRead=True).get('Item', {}).get('record')


def validate_retry(existing, submitted):
    fields = ['score', 'correct', 'total', 'mode'] + (['name'] if submitted.get('name') else [])
    if submitted['mode'].startswith('memory-'):fields += ['durationMs','moves','pairs']
    if any(existing[field] != submitted[field] for field in fields) or any(existing.get(field, 0) != submitted.get(field, 0) for field in ['hintsUsed', 'timeBonus']):
        raise RequestError(409, '이 기록은 이미 저장됐어. 순위에서 확인해봐.')
    if 'partnerId' in submitted and existing.get('partnerId') != submitted['partnerId']:
        raise RequestError(409, '이 기록은 이미 저장됐어. 순위에서 확인해봐.')


def archive_record(storage, record):
    # Immutable rows keep original records outside the bounded leaderboard item.
    # A failed archive never permits the original board to be overwritten.
    try:
        storage.put_item(Item={'mode': history_key(record['mode'], record['id']), 'boardMode': record['mode'], 'record': record},
                         ConditionExpression='attribute_not_exists(#mode)', ExpressionAttributeNames={'#mode': 'mode'})
        return record
    except Exception as error:
        if getattr(error, 'response', {}).get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            raise
        previous = archived_record(storage, record['mode'], record['id'])
        if previous is None: raise
        validate_retry(previous, record)
        return previous


def winner_result(entries, winner, record):
    return {'qualified': True, 'rank': entries.index(winner) + 1, 'record': winner, 'entries': entries, 'keptBest': winner['id'] != record['id']}


def save(storage, submitted):
    record = {**submitted, 'date': timestamp()}
    archived = False
    retry_record = False
    archived_ids = set()
    for _ in range(8):
        item, entries = board(storage, record['mode'])
        raw_entries = (item or {}).get('entries', [])
        existing = next((entry for entry in raw_entries if entry['id'] == record['id']), None)
        if existing:
            validate_retry(existing, submitted)
            winner = next(entry for entry in entries if trainer_key(entry) == trainer_key(existing))
            return winner_result(entries, winner, existing)
        if not archived:
            previous = archived_record(storage, record['mode'], record['id'])
            if previous:
                retry_record = True
                validate_retry(previous, submitted)
                record = previous
            else:
                if not record['name']: record['name'] = random.choice(NAMES)
                record = archive_record(storage, record)
            archived = True
        previous = next((entry for entry in entries if trainer_key(entry) == trainer_key(record)), None)
        if previous and (performance_value(previous) > performance_value(record) or performance_value(previous) == performance_value(record) and retry_record and sort_key(previous) <= sort_key(record)):
            return winner_result(entries, previous, record)
        others = [entry for entry in entries if trainer_key(entry) != trainer_key(record)]
        updated = sorted([*others, record], key=sort_key)[:LIMIT]
        if record not in updated:
            return {'qualified': False, 'rank': None, 'entries': entries}
        # Copy every original legacy row before grouping or evicting any row.
        known = set((item or {}).get('archivedIds', [])) | archived_ids
        for original in raw_entries:
            if original['id'] not in known:
                archive_record(storage, original)
                archived_ids.add(original['id'])
        version = int(item.get('version', 0)) if item else 0
        kwargs = {'Item': {**(item or {}), 'mode': record['mode'], 'version': version + 1, 'entries': updated,
                           'archivedIds': [row['id'] for row in updated]}}
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


def save_monthly_record(storage, record):
    """Merge one immutable original without altering lifetime boards or other months."""
    month = ranking_month(record['date'])
    key = monthly_key(record['mode'], month)
    for _ in range(8):
        item, entries = board(storage, record['mode'], month)
        updated = best_entries(list({row['id']:row for row in [record, *entries]}.values()))[:LIMIT]
        winner = next((row for row in updated if trainer_key(row) == trainer_key(record)), None)
        result = winner_result(updated, winner, record) if winner else {'qualified':False, 'rank':None, 'record':record, 'entries':updated}
        result['month'] = month
        if item and item.get('entries') == updated:
            return result
        kwargs = {'Item': {**(item or {}), 'mode':key, 'boardMode':record['mode'], 'month':month,
                           'version':int((item or {}).get('version', 0)) + 1, 'entries':updated}}
        if item:
            kwargs.update(ConditionExpression='#version = :expected', ExpressionAttributeNames={'#version':'version'},
                          ExpressionAttributeValues={':expected':int(item.get('version', 0))})
        else:
            kwargs.update(ConditionExpression='attribute_not_exists(#mode)', ExpressionAttributeNames={'#mode':'mode'})
        try:
            storage.put_item(**kwargs)
            return result
        except Exception as error:
            if getattr(error, 'response', {}).get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
    raise RequestError(409, '친구의 기록이 먼저 도착했네! 한 번 더 저장해줘.')


def save_with_monthly(storage, submitted, monthly=False):
    lifetime = save(storage, submitted)
    original = archived_record(storage, submitted['mode'], submitted['id'])
    if original is None:
        # Legacy retries can still live only in the original board.
        item = storage.get_item(Key={'mode':submitted['mode']}, ConsistentRead=True).get('Item', {})
        original = next(row for row in item.get('entries', []) if row['id'] == submitted['id'])
        original = archive_record(storage, original)
    result = save_monthly_record(storage, original)
    save_personal_best(storage, original)
    return result if monthly else lifetime


def personal_key(mode, name, pairs=None):
    digest = hashlib.sha256(unicodedata.normalize('NFKC', name).strip().lower().encode()).hexdigest()
    return f'personal#{mode}#{str(pairs)+"#" if pairs is not None else ""}{digest}'


def personal_best(storage, mode, name):
    if not isinstance(name, str) or len(name) > 12 or any(unicodedata.category(c).startswith('C') for c in name):
        raise RequestError(400, '트레이너 이름을 다시 확인해줘.')
    pairs = {'memory-easy':8,'memory-normal':12,'memory-hard':15}.get(mode)
    row = storage.get_item(Key={'mode':personal_key(mode, name, pairs)}, ConsistentRead=True).get('Item', {})
    _, legacy = board(storage, mode)
    candidates = [r for r in [*legacy, *([row['record']] if row.get('record') else [])]
                  if trainer_key(r) == trainer_key({'name':name,'id':''})]
    return min(candidates, key=sort_key) if candidates else None


def save_personal_best(storage, record):
    key = personal_key(record['mode'], record['name'], record.get('pairs'))
    for _ in range(8):
        item = storage.get_item(Key={'mode':key}, ConsistentRead=True).get('Item')
        if item and sort_key(item['record']) <= sort_key(record):return item['record']
        kwargs = {'Item':{**(item or {}),'mode':key,'boardMode':record['mode'],'version':int((item or {}).get('version',0))+1,'record':record}}
        if item:
            kwargs.update(ConditionExpression='#version = :expected',ExpressionAttributeNames={'#version':'version'},ExpressionAttributeValues={':expected':int(item.get('version',0))})
        else:
            kwargs.update(ConditionExpression='attribute_not_exists(#mode)',ExpressionAttributeNames={'#mode':'mode'})
        try:
            storage.put_item(**kwargs);return record
        except Exception as error:
            if getattr(error,'response',{}).get('Error',{}).get('Code') != 'ConditionalCheckFailedException':raise
    raise RequestError(409, '최고기록을 다시 확인하고 있어. 한 번 더 저장해줘.')


def handle(event, context=None, storage=None, access_storage=None):
    try:
        headers = {key.lower(): value for key, value in (event.get('headers') or {}).items()}
        origin = headers.get('origin')
        allowed = json.loads(os.environ.get('ALLOWED_ORIGINS', '["https://pokemon.pir.kr"]'))
        if origin and origin not in allowed:
            raise RequestError(403, '여기서는 기록을 남길 수 없어. 게임 화면으로 돌아와줘.')
        method = event.get('requestContext', {}).get('http', {}).get('method')
        path = (event.get('rawPath') or '').rstrip('/')
        if path.startswith(('/api/access/', '/api/admin/')):
            import access
            try:
                status, data, cookies = access.dispatch(event, storage=access_storage)
                return response(status, data, cookies)
            except access.AccessError as error:
                return response(error.status, {'error': error.message, 'reason': error.reason}, access.clear_cookies() if error.reason == 'invalid_device' else None)
        device = None
        if path in ['/api/rankings', '/api/scores', '/api/game-settings'] and os.environ.get('AUTH_REQUIRED') == '1':
            import access
            try: device = access.require_device(headers.get('x-device-key'), access_storage)
            except access.AccessError as error:
                return response(error.status, {'error': error.message, 'reason': 'invalid_device'}, access.clear_cookies())
        if method == 'GET' and path == '/api/game-settings':
            import access, settings
            return response(200, {'settings':settings.read(access_storage if access_storage is not None else access.store())})
        if method == 'GET' and path == '/api/rankings':
            query = event.get('queryStringParameters') or {}
            mode = valid_mode(query.get('mode'))
            month = valid_month(query['month']) if 'month' in query else None
            target = storage if storage is not None else table()
            _, entries = board(target, mode, month)
            personal = {'personalBest':personal_best(target,mode,query['trainer'])} if 'trainer' in query else {}
            return response(200, public_result({'mode': mode, 'entries': entries, 'serverTime': timestamp(), **({'month':month} if month else {}), **personal}))
        if method == 'POST' and path == '/api/scores':
            if not headers.get('content-type', '').lower().startswith('application/json'):
                raise RequestError(415, '기록을 읽지 못했어. 다시 저장해줘.')
            query = event.get('queryStringParameters') or {}
            if 'month' in query: valid_month(query['month'])
            submitted = parse_submission(event)
            if device: submitted['deviceId'] = device['deviceId']
            submitted['userAgent'] = str(headers.get('user-agent') or event.get('requestContext', {}).get('http', {}).get('userAgent') or '')[:240]
            return response(200, public_result(save_with_monthly(storage if storage is not None else table(), submitted, 'month' in query)))
        raise RequestError(404, '여기는 찾지 못했어. 게임 화면으로 돌아가볼까?')
    except RequestError as error:
        return response(error.status, {'error': error.message})
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}))
        return response(503, {'error': '순위에 연결하지 못했어. 잠깐 뒤에 다시 눌러줘.'})
