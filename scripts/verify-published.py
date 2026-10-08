"""Smoke-check public admission, private asset protection and ranking authorization."""
import json
import urllib.error
import urllib.request

ORIGIN='https://pokemon.pir.kr'

def fetch(path):
    try:
        with urllib.request.urlopen(ORIGIN+path,timeout=20) as response:return response.status,response.read()
    except urllib.error.HTTPError as error:return error.code,error.read()

status,body=fetch('/')
assert status==200 and '포켓몬 파티 초대장' in body.decode(), 'Public invitation shell is unavailable.'
status,body=fetch('/admin');assert status==200 and '파티 관리자' in body.decode(), 'Administrator shell is unavailable.'
status,body=fetch('/api/access/config');assert status==200
config=json.loads(body)
for resource in ['/game.html','/pokemon.json','/pokedex-manifest.json','/api/rankings?mode=time-easy']:
    status,body=fetch(resource)
    if config['enabled']:
        assert status in [401,403],f'Unauthenticated access was allowed: {resource}'
    else:assert status==200,f'Initial rollout is unavailable: {resource}'
status,_=fetch('/api/admin/devices');assert status in [401,403],'Administrator API must require a login.'
print('Verified invitation shell, administrator login and access restrictions; enabled=',config['enabled'])
