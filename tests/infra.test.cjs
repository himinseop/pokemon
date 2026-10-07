const {test}=require('node:test');
const assert=require('node:assert/strict');
const cdk=require('aws-cdk-lib');
const {Template}=require('aws-cdk-lib/assertions');
const {PokemonPlayStack,validateConfig}=require('../infra/lib/pokemon-play-stack.cjs');
const config=require('../infra/config.json');
function template(overrides={}){return Template.fromStack(new PokemonPlayStack(new cdk.App(),config.stackName,{...config,...overrides})).toJSON();}
function resources(t,type){return Object.values(t.Resources).filter(r=>r.Type===type);}
test('private retained S3 and CloudFront OAC serve only HTTPS',()=>{
 const t=template();const bucket=resources(t,'AWS::S3::Bucket')[0];
 assert.equal(bucket.DeletionPolicy,'Retain');assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration,{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true});
 assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership,'BucketOwnerEnforced');
 assert.equal(resources(t,'AWS::CloudFront::OriginAccessControl').length,1);
 const d=resources(t,'AWS::CloudFront::Distribution')[0].Properties.DistributionConfig;
 assert.equal(d.DefaultCacheBehavior.ViewerProtocolPolicy,'redirect-to-https');assert.deepEqual(d.DefaultCacheBehavior.AllowedMethods,['GET','HEAD']);assert.deepEqual(d.Aliases,['pokemon.pir.kr']);
 assert.equal(d.DefaultRootObject,'index.html');assert.ok(!d.CustomErrorResponses);
 assert.equal(resources(t,'AWS::DynamoDB::Table').length,1);assert.equal(resources(t,'AWS::SQS::Queue').length,0);
});
test('GitHub OIDC trusts only the specific production environment, including immutable IDs',()=>{
 const t=template(),role=resources(t,'AWS::IAM::Role').find(r=>r.Properties.RoleName==='pokemon-play-prod-github-deploy');
 const trust=role.Properties.AssumeRolePolicyDocument.Statement[0];assert.equal(trust.Action,'sts:AssumeRoleWithWebIdentity');
 const conditions=trust.Condition.StringEquals;assert.equal(conditions['token.actions.githubusercontent.com:aud'],'sts.amazonaws.com');
 assert.deepEqual(conditions['token.actions.githubusercontent.com:sub'],['repo:himinseop/pokemon:environment:production','repo:himinseop@1148821/pokemon@1400912995:environment:production']);
 assert.ok(!role.Properties.ManagedPolicyArns);
 const policy=resources(t,'AWS::IAM::Policy').find(r=>r.Properties.PolicyName.startsWith('GitHubDeployRole'));
 const statements=policy.Properties.PolicyDocument.Statement;
 const actions=statements.flatMap(s=>[].concat(s.Action));
 assert.deepEqual(actions.sort(),['s3:ListBucket','s3:GetBucketLocation','s3:GetObject','s3:PutObject','cloudfront:CreateInvalidation','cloudfront:GetInvalidation','cloudformation:DescribeStacks','lambda:UpdateFunctionCode','lambda:GetFunctionConfiguration'].sort());
 assert.ok(statements.every(s=>s.Resource!=='*'));
});
test('existing certificate and account-wide OIDC provider can be reused',()=>{
 const t=template({certificateArn:`arn:aws:acm:us-east-1:${config.account}:certificate/12345678-1234-1234-1234-123456789abc`,githubOidcProviderArn:`arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`});
 assert.ok(!Object.keys(t.Resources).some(key=>key.includes('CertificateRequestor')||key.includes('GitHubOidcProvider')));
 assert.equal(resources(t,'AWS::Route53::RecordSet').length,2);
});
test('configuration rejects wrong certificate region, other account provider and broad repository trust',()=>{
 assert.throws(()=>validateConfig({...config,certificateArn:`arn:aws:acm:ap-northeast-2:${config.account}:certificate/abc`}));
 assert.throws(()=>validateConfig({...config,githubOidcProviderArn:'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com'}));
 assert.throws(()=>validateConfig({...config,githubRepository:'himinseop/*'}));
 assert.throws(()=>validateConfig({...config,githubRepositoryId:''}));
});

test('shared rankings use one retained on-demand board table and uncached API requests',()=>{
 const t=template(),table=resources(t,'AWS::DynamoDB::Table')[0];
 assert.equal(table.DeletionPolicy,'Retain');assert.equal(table.Properties.BillingMode,'PAY_PER_REQUEST');assert.deepEqual(table.Properties.KeySchema,[{AttributeName:'mode',KeyType:'HASH'}]);
 const fn=resources(t,'AWS::Lambda::Function').find(r=>r.Properties.FunctionName==='pokemon-play-prod-rankings');
 assert.equal(fn.Properties.Runtime,'python3.13');assert.equal(fn.Properties.ReservedConcurrentExecutions,5);assert.equal(fn.Properties.Timeout,8);assert.equal(fn.Properties.MemorySize,256);
 const api=resources(t,'AWS::ApiGatewayV2::Api')[0];assert.equal(api.Properties.ProtocolType,'HTTP');
 const routes=resources(t,'AWS::ApiGatewayV2::Route').map(r=>r.Properties.RouteKey).sort();assert.deepEqual(routes,['GET /api/rankings','POST /api/scores']);
 const d=resources(t,'AWS::CloudFront::Distribution')[0].Properties.DistributionConfig;
 const behavior=d.CacheBehaviors.find(b=>b.PathPattern==='api/*');assert.ok(behavior);assert.ok(behavior.AllowedMethods.includes('POST'));
 assert.equal(behavior.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
 const execution=resources(t,'AWS::IAM::Policy').find(r=>r.Properties.PolicyName.startsWith('RankingFunction'));
 const data=execution.Properties.PolicyDocument.Statement.find(s=>[].concat(s.Action).includes('dynamodb:GetItem'));assert.deepEqual([].concat(data.Action).sort(),['dynamodb:GetItem','dynamodb:PutItem']);assert.notEqual(data.Resource,'*');
});
