"""Exercise the real boto3 serializers, catching high/low-level client confusion."""
import os
import sys
import unittest
from pathlib import Path
os.environ.update(AWS_ACCESS_KEY_ID='test',AWS_SECRET_ACCESS_KEY='test',AWS_DEFAULT_REGION='ap-northeast-2',AWS_EC2_METADATA_DISABLED='true',ACCESS_TABLE_NAME='pokemon-test-access')
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'infra/ranking'))
import access
from botocore.stub import Stubber


class TransactionSdkTests(unittest.TestCase):
    def setUp(self):
        self.db=access.DynamoStore();self.requests=[]
        self.db.client.meta.events.register('before-parameter-build.dynamodb.TransactWriteItems',lambda params,**_:self.requests.append(params.copy()))
        self.stub=Stubber(self.db.client);self.stub.add_response('transact_write_items',{});self.stub.activate();self.addCleanup(self.stub.deactivate)
    def test_issue_uses_low_level_attribute_values_once_and_enforces_share_expiry(self):
        self.assertIsNot(self.db.client,self.db.table.meta.client)
        self.db.issue('sharehash',{'id':'device#id','kind':'device','visitCount':0},100)
        items=self.requests[0]['TransactItems'];grant=items[0]['Update'];self.assertEqual(grant['Key']['id'],{'S':'share#sharehash'})
        self.assertEqual(grant['ExpressionAttributeValues'][':now'],{'N':'100'});self.assertIn('expiresAt>:now',grant['ConditionExpression']);self.assertEqual(items[1]['Put']['Item']['visitCount'],{'N':'0'})
        self.stub.assert_no_pending_responses()
    def test_visit_is_atomic_and_checks_that_device_is_still_active(self):
        visit={'id':'visit#id','createdAt':'2026-10-08T00:00:00Z','trainerName':'지우','userAgent':'Safari'}
        self.db.visit({'id':'device#id'},visit);items=self.requests[0]['TransactItems'];grant=items[0]['Update']
        self.assertEqual(grant['Key']['id'],{'S':'device#id'});self.assertEqual(grant['ExpressionAttributeValues'][':active'],{'S':'active'});self.assertEqual(grant['ConditionExpression'],'#status=:active')
        self.assertEqual(items[1]['Put']['Item']['trainerName'],{'S':'지우'});self.stub.assert_no_pending_responses()


unittest.main()
