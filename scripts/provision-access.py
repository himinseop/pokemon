"""Provision a signing secret and an administrator without emailing credentials."""
import argparse
import json
import os
import re
import secrets
import string
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'infra/ranking/vendor'))
import rsa


def provision(email, profile):
    if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
        raise ValueError('관리자 이메일 주소를 확인해 주세요.')
    config = json.loads((ROOT / 'infra/config.json').read_text())
    prefix = ['aws', '--profile', profile, '--region', config['region']]
    def aws(*args, optional=False):
        result = subprocess.run(prefix + list(args) + ['--output','json'], capture_output=True, text=True)
        if result.returncode:
            if optional and 'UserNotFoundException' in result.stderr: return None
            raise RuntimeError(result.stderr.strip())
        return json.loads(result.stdout) if result.stdout.strip() else {}
    if aws('sts','get-caller-identity')['Account'] != config['account']:
        raise ValueError('설정과 다른 AWS 계정입니다.')
    stack = aws('cloudformation','describe-stacks','--stack-name',config['stackName'])['Stacks'][0]
    if stack['StackStatus'] not in ['CREATE_COMPLETE','UPDATE_COMPLETE']:
        raise ValueError('AWS 구성이 완료된 뒤 실행해 주세요.')
    outputs = {row['OutputKey']:row['OutputValue'] for row in stack['Outputs']}
    private_file = ROOT / 'exports/cloudfront-private.pem'
    public = rsa.PublicKey.load_pkcs1_openssl_pem((ROOT / 'infra/cloudfront-public.pem').read_bytes())
    pem = private_file.read_bytes()
    private = rsa.PrivateKey.load_pkcs1(pem)
    if (public.n,public.e) != (private.n,private.e):
        raise ValueError('로컬 서명 키가 공개 키와 다릅니다. 키를 교체하지 않았습니다.')
    parameter = outputs['SigningParameterName']
    # Never replace a signing key accidentally. Existing deployments must retain the same key.
    result = subprocess.run(prefix+['ssm','get-parameter','--name',parameter,'--with-decryption','--output','json'],capture_output=True,text=True)
    if result.returncode == 0:
        stored = rsa.PrivateKey.load_pkcs1(json.loads(result.stdout)['Parameter']['Value'].encode())
        if (stored.n,stored.e) != (public.n,public.e):raise ValueError('AWS 서명 키가 다릅니다. 기존 키를 유지했습니다.')
    elif 'ParameterNotFound' in result.stderr:
        aws('ssm','put-parameter','--name',parameter,'--type','SecureString','--tier','Standard','--value','file://'+str(private_file),'--description','Pokemon CloudFront invitation cookie signing key')
    else:raise RuntimeError(result.stderr.strip())
    pool = outputs['AdminPoolId']
    user = aws('cognito-idp','admin-get-user','--user-pool-id',pool,'--username',email,optional=True)
    credential_file = None
    if user is None or user.get('UserStatus') in ['FORCE_CHANGE_PASSWORD','RESET_REQUIRED']:
        alphabet = string.ascii_letters + string.digits + '!@#%_-'
        password = 'aA1!'+''.join(secrets.choice(alphabet) for _ in range(24))
        if user is None:aws('cognito-idp','admin-create-user','--user-pool-id',pool,'--username',email,'--message-action','SUPPRESS','--user-attributes',json.dumps([{'Name':'email','Value':email},{'Name':'email_verified','Value':'true'}]))
        # Pass the password through a private file, never shell interpolation or terminal output.
        payload_file = ROOT / 'exports/admin-password-request.json'
        fd=os.open(payload_file,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as stream:json.dump({'UserPoolId':pool,'Username':email,'Password':password,'Permanent':True},stream)
        try:aws('cognito-idp','admin-set-user-password','--cli-input-json','file://'+str(payload_file))
        finally:payload_file.unlink(missing_ok=True)
        credential_file=ROOT/'exports/admin-credentials.txt'
        fd=os.open(credential_file,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600);os.fchmod(fd,0o600)
        with os.fdopen(fd,'w') as stream:stream.write(f'관리자 페이지: {outputs["AdminUrl"]}\n이메일: {email}\n비밀번호: {password}\n')
    aws('cognito-idp','admin-add-user-to-group','--user-pool-id',pool,'--username',email,'--group-name','admins')
    print('관리자 계정과 초대장 서명 설정을 완료했습니다.')
    if credential_file:print('로그인 정보는 로컬 비공개 파일에 저장했습니다:',credential_file)
    else:print('기존 관리자 비밀번호를 유지했습니다.')


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--email',required=True);parser.add_argument('--profile',default='podbbangcast');args=parser.parse_args()
    try:provision(args.email,args.profile)
    except (ValueError,KeyError,RuntimeError,OSError) as error:print('관리자 설정을 멈췄습니다:',error,file=sys.stderr);sys.exit(1)
