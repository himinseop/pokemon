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
        visit={'id':'visit#id','createdAt':'2026-10-08T00:00:00Z','trainerName':'지우','userAgent':'Safari','visitedAt':1791400000}
        self.db.visit({'id':'device#id'},visit);items=self.requests[0]['TransactItems'];grant=items[0]['Update']
        self.assertEqual(grant['Key']['id'],{'S':'device#id'});self.assertEqual(grant['ExpressionAttributeValues'][':active'],{'S':'active'});self.assertIn('#status=:active',grant['ConditionExpression']);self.assertIn('lastVisitAt<=:cutoff',grant['ConditionExpression']);self.assertIn('#trainer<>:trainer',grant['ConditionExpression']);self.assertEqual(grant['ExpressionAttributeValues'][':trainer'],{'S':'지우'});self.assertEqual(grant['ExpressionAttributeValues'][':cutoff'],{'N':str(1791400000-access.VISIT_SECONDS)})
        self.assertEqual(items[1]['Put']['Item']['trainerName'],{'S':'지우'});self.stub.assert_no_pending_responses()

    def test_refresh_touches_active_device_without_creating_a_visit(self):
        self.stub.deactivate();requests=[]
        self.db.table.meta.client.meta.events.register('before-parameter-build.dynamodb.UpdateItem',lambda params,**_:requests.append(params.copy()))
        with Stubber(self.db.table.meta.client) as stub:
            stub.add_response('update_item',{'Attributes':{'id':{'S':'device#id'},'lastSeenAt':{'S':'2026-10-08T01:00:00Z'},'visitCount':{'N':'1'}}})
            row=self.db.touch({'id':'device#id'},{'lastSeenAt':'2026-10-08T01:00:00Z'})
            self.assertEqual(row['visitCount'],1);self.assertEqual(row['lastSeenAt'],'2026-10-08T01:00:00Z')
            self.assertEqual(requests[0]['ConditionExpression'],'#status=:active');self.assertEqual(self.requests,[])
            stub.assert_no_pending_responses()

    def test_device_filter_skips_empty_index_pages_and_retains_filter_on_next_page(self):
        self.stub.deactivate();requests=[];device='a'*32
        self.db.table.meta.client.meta.events.register('before-parameter-build.dynamodb.Query',lambda params,**_:requests.append(params.copy()))
        key={'id':{'S':'visit#previous'},'kind':{'S':'visit'},'createdAt':{'S':'2026-10-08T01:00:00Z'}}
        with Stubber(self.db.table.meta.client) as stub:
            stub.add_response('query',{'Items':[],'LastEvaluatedKey':key})
            stub.add_response('query',{'Items':[{'id':{'S':'visit#mine'},'kind':{'S':'visit'},'deviceId':{'S':device},'createdAt':{'S':'2026-10-08T00:00:00Z'}}]})
            rows,cursor=self.db.list('visit',device_id=device)
            self.assertEqual(rows[0]['deviceId'],device);self.assertIsNone(cursor);self.assertEqual(len(requests),2)
            self.assertTrue(all(r['FilterExpression']=='#device=:device' for r in requests));self.assertIn('ExclusiveStartKey',requests[1])
            stub.assert_no_pending_responses()


unittest.main()
