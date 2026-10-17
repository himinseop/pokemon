"""Validated gameplay settings; separate from invitations, devices and rankings."""
import copy
import json
from decimal import Decimal
from pathlib import Path

KEY = 'settings#gameplay'
DEFAULT = json.loads((Path(__file__).parent / 'game-settings.json').read_text())
NAMES = json.loads((Path(__file__).parent / 'pokemon-names.json').read_text())


def validate(data):
    if not isinstance(data, dict): raise ValueError('설정을 다시 확인해 주세요.')
    rates, ids, version = data.get('timeFamiliarPercent'), data.get('familiarIds'), data.get('version')
    if not isinstance(rates, dict) or set(rates) != {'easy', 'normal', 'hard'} or any(type(v) is not int or not 0 <= v <= 100 or v % 10 for v in rates.values()):
        raise ValueError('출제 비율은 0~100% 사이에서 10%씩 조절해 주세요.')
    if not isinstance(ids, list) or not 10 <= len(ids) <= 1025 or any(type(v) is not int or not 1 <= v <= 1025 for v in ids) or len(set(ids)) != len(ids):
        raise ValueError('친숙한 포켓몬을 중복 없이 10종 이상 골라 주세요.')
    if type(version) is not int or version < 0: raise ValueError('최신 설정을 다시 불러와 주세요.')
    return {'version': version, 'timeFamiliarPercent': dict(rates), 'familiarIds': sorted(ids)}


def read(storage):
    row = storage.get(KEY)
    return validate(json.loads(json.dumps(row['settings'],default=lambda value:int(value) if isinstance(value,Decimal) else value))) if row else copy.deepcopy(DEFAULT)


def save(storage, data, admin, now):
    validated = validate(data)
    saved = {**validated, 'version': validated['version'] + 1}
    storage.save_settings({'id': KEY, 'settings': saved, 'updatedBy': admin, 'updatedAt': now}, validated['version'])
    return saved
