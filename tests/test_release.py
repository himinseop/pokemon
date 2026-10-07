import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def module(name, file):
    spec=importlib.util.spec_from_file_location(name, ROOT/'scripts'/file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
builder=module('builder','build-aws.py')
deployer=module('deployer','deploy-aws.py')

class ReleaseTests(unittest.TestCase):
    def release(self, root):
        (root/'assets').mkdir();(root/'assets/a-123.png').write_bytes(b'image')
        (root/'index.html').write_text('ready');(root/'app-123.js').write_text('app')
        files={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
        (root/'release-manifest.json').write_text(json.dumps({'revision':'test','files':files}))
    def test_same_sized_changed_images_have_different_keys(self):
        self.assertNotEqual(builder.asset_name('assets/001.png',b'abc'),builder.asset_name('assets/001.png',b'xyz'))
        self.assertEqual(builder.asset_name('assets/001.png',b'abc'),builder.asset_name('assets/001.png',b'abc'))
    def test_json_and_css_paths_are_rewritten_without_partial_matches(self):
        mapping={'assets/001.png':'assets/001-a.png','assets/ui/type-normal.png':'assets/ui/type-normal-b.png'}
        text='{"image":"assets/001.png","other":"assets/1001.png"} url(assets/ui/type-normal.png)'
        result=builder.rewrite(text,mapping)
        self.assertIn('assets/001-a.png',result);self.assertIn('assets/1001.png',result);self.assertIn('url(assets/ui/type-normal-b.png)',result)
    def test_release_rejects_modified_missing_or_extra_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.release(root);deployer.validate_release(root)
            (root/'index.html').write_text('tampered')
            with self.assertRaises(ValueError):deployer.validate_release(root)
            self.release_reset(root)
            (root/'private.env').write_text('not for publish')
            with self.assertRaises(ValueError):deployer.validate_release(root)
    def release_reset(self, root):
        (root/'index.html').write_text('ready')
    def test_account_mismatch_prevents_all_uploads(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.release(root);calls=[]
            def run(args,**kwargs):
                calls.append(args);return subprocess.CompletedProcess(args,0,json.dumps({'Account':'111111111111'}))
            with self.assertRaises(ValueError):deployer.publish(root,run=run)
            self.assertEqual(len(calls),1);self.assertIn('get-caller-identity',calls[0])
    def test_publish_retains_old_assets_switches_index_last_and_waits_for_invalidation(self):
        config=json.loads((ROOT/'infra/config.json').read_text());calls=[]
        outputs={'SiteUrl':'https://pokemon.pir.kr','WebBucketName':'pokemon-web-test','DistributionId':'EXAMPLE','RankingFunctionName':'pokemon-play-prod-rankings'}
        def run(args,**kwargs):
            calls.append(args)
            if 'get-caller-identity' in args:payload={'Account':config['account']}
            elif 'describe-stacks' in args:payload={'Stacks':[{'StackStatus':'CREATE_COMPLETE','Outputs':[{'OutputKey':k,'OutputValue':v} for k,v in outputs.items()]}]}
            elif 'create-invalidation' in args:payload={'Invalidation':{'Id':'test'}}
            else:payload={}
            return subprocess.CompletedProcess(args,0,json.dumps(payload))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'web';root.mkdir();self.release(root);backend=Path(folder)/'backend';backend.mkdir();(backend/'ranking-function.zip').write_bytes(b'code');(backend/'ranking-release.json').write_text(json.dumps({'revision':'test','sha256':hashlib.sha256(b'code').hexdigest()}));deployer.publish(root,run=run,ranking_source=backend)
        self.assertEqual(len(calls),9)
        self.assertIn('update-function-code',calls[2]);self.assertIn('function-updated',calls[3]);self.assertIn('--size-only',calls[4]);self.assertIn('no-cache',calls[5]);self.assertIn('index.html',str(calls[6]))
        self.assertIn('invalidation-completed',calls[-1]);self.assertTrue(all('--delete' not in args for args in calls))
    def test_invalid_stack_domain_prevents_uploads(self):
        config=json.loads((ROOT/'infra/config.json').read_text());calls=[]
        def run(args,**kwargs):
            calls.append(args)
            payload={'Account':config['account']} if 'get-caller-identity' in args else {'Stacks':[{'StackStatus':'CREATE_COMPLETE','Outputs':[{'OutputKey':'SiteUrl','OutputValue':'https://podcast.pir.kr'}]}]}
            return subprocess.CompletedProcess(args,0,json.dumps(payload))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);self.release(root)
            with self.assertRaises(ValueError):deployer.publish(root,run=run)
        self.assertEqual(len(calls),2)

    def test_mismatched_backend_release_never_updates_a_function_or_uploads_files(self):
        config=json.loads((ROOT/'infra/config.json').read_text());calls=[]
        def run(args,**kwargs):
            calls.append(args)
            payload={'Account':config['account']} if 'get-caller-identity' in args else {'Stacks':[{'StackStatus':'CREATE_COMPLETE','Outputs':[{'OutputKey':k,'OutputValue':v} for k,v in {'SiteUrl':'https://pokemon.pir.kr','WebBucketName':'test','DistributionId':'test','RankingFunctionName':'pokemon-play-prod-rankings'}.items()]}]}
            return subprocess.CompletedProcess(args,0,json.dumps(payload))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'web';root.mkdir();self.release(root);backend=Path(folder)/'backend';backend.mkdir()
            (backend/'ranking-function.zip').write_bytes(b'code')
            (backend/'ranking-release.json').write_text(json.dumps({'revision':'different','sha256':hashlib.sha256(b'code').hexdigest()}))
            with self.assertRaises(ValueError):deployer.publish(root,run=run,ranking_source=backend)
        self.assertEqual(len(calls),2)
