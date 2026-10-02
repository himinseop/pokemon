"""Publish a verified release to the dedicated CDK stack using AWS CLI v2."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate_release(source):
    manifest = json.loads((source / 'release-manifest.json').read_text(encoding='utf-8'))
    if not manifest.get('files') or 'index.html' not in manifest['files']:
        raise ValueError('Build a complete release before publishing.')
    actual = {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()}
    if actual != set(manifest['files']) | {'release-manifest.json'}:
        raise ValueError('The release contains missing or unverified files.')
    for name, checksum in manifest['files'].items():
        path = source / name
        if path.is_symlink() or '..' in Path(name).parts or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError(f'Changed or unsafe release file: {name}')
    return manifest


def publish(source=ROOT / 'dist-aws', profile=None, run=subprocess.run):
    source = Path(source)
    manifest = validate_release(source)
    config = json.loads((ROOT / 'infra/config.json').read_text(encoding='utf-8'))
    prefix = ['aws', '--region', config['region']]
    if profile: prefix += ['--profile', profile]
    def aws(arguments, json_result=False):
        result = run(prefix + arguments, check=True, text=True, capture_output=json_result)
        return json.loads(result.stdout) if json_result else result
    identity = aws(['sts', 'get-caller-identity', '--output', 'json'], True)
    if identity['Account'] != config['account']:
        raise ValueError('AWS account does not match infra/config.json; no files uploaded.')
    stacks = aws(['cloudformation', 'describe-stacks', '--stack-name', config['stackName'], '--output', 'json'], True)['Stacks']
    stack = stacks[0]
    if stack['StackStatus'] not in ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE']:
        raise ValueError('Wait until the infrastructure stack is stable before publishing.')
    outputs = {item['OutputKey']: item['OutputValue'] for item in stack['Outputs']}
    if outputs['SiteUrl'] != f'https://{config["domainName"]}':
        raise ValueError('The stack domain does not match the deployment configuration.')
    bucket, distribution = outputs['WebBucketName'], outputs['DistributionId']
    if not bucket or not distribution:
        raise ValueError('Missing CloudFormation bucket/distribution outputs.')
    destination = f's3://{bucket}'
    # Size-only is safe for content-addressed images: any content change gets a new key.
    aws(['s3', 'sync', str(source / 'assets'), destination+'/assets', '--size-only', '--cache-control', 'public,max-age=31536000,immutable', '--only-show-errors'])
    # Upload mutable data and versioned JS/CSS before switching the entry page.
    aws(['s3', 'sync', str(source), destination, '--exclude', 'assets/*', '--exclude', 'index.html', '--cache-control', 'no-cache', '--only-show-errors'])
    aws(['s3', 'cp', str(source / 'index.html'), destination+'/index.html', '--content-type', 'text/html; charset=utf-8', '--cache-control', 'no-cache,no-store,must-revalidate', '--only-show-errors'])
    invalidation = aws(['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', '/*', '--output', 'json'], True)['Invalidation']['Id']
    aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distribution, '--id', invalidation])
    print(f'Published revision {manifest["revision"]}: {outputs["SiteUrl"]}')
    return outputs


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', help='Use a local AWS SSO profile; Actions uses OIDC credentials.')
    args = parser.parse_args()
    try: publish(profile=args.profile)
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Deployment stopped: {error}', file=sys.stderr)
        sys.exit(1)
