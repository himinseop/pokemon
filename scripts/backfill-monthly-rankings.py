"""Recover month boards from preserved originals. Dry-run unless --apply is explicit."""
import argparse
from collections import defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'infra/ranking'))
import handler


def originals(items):
    records = {}
    for item in items:
        for row in [*item.get('entries', []), *([item['record']] if 'record' in item else [])]:
            if row.get('mode') in handler.MODES:
                records[(row['mode'], row['id'])] = row
    return records.values()


def recover(storage, items, apply=False):
    records = list(originals(items))
    groups = defaultdict(list)
    for row in records:
        groups[(handler.ranking_month(row['date']), row['mode'])].append(row)
    if apply:
        for row in records:
            # Preserve missing legacy originals before adding any monthly projection.
            original = handler.archive_record(storage, row)
            handler.save_personal_best(storage, original)
            if row['mode'].startswith('memory-') and row.get('pairs') != {'memory-easy':8,'memory-normal':12,'memory-hard':15}[row['mode']]:
                continue
            handler.save_monthly_record(storage, original)
    return {'originals':len(records), 'months':len({month for month, _ in groups}), 'boards':len(groups), 'applied':apply}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='podbbangcast')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    import boto3
    session = boto3.Session(profile_name=args.profile, region_name='ap-northeast-2')
    if session.client('sts').get_caller_identity()['Account'] != '733625312722':
        raise SystemExit('Wrong AWS account; no data modified.')
    storage = session.resource('dynamodb').Table('pokemon-play-prod-rankings')
    items, options = [], {'ConsistentRead':True}
    while True:
        page = storage.scan(**options)
        items.extend(page.get('Items', []))
        if 'LastEvaluatedKey' not in page:break
        options['ExclusiveStartKey'] = page['LastEvaluatedKey']
    print(recover(storage, items, args.apply))


if __name__ == '__main__':main()
