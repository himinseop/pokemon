const {test}=require('node:test');
const assert=require('node:assert/strict');
const cdk=require('aws-cdk-lib');
const {Template}=require('aws-cdk-lib/assertions');
const {PokemonPlayStack,validateConfig}=require('../infra/lib/pokemon-play-stack.cjs');
const config=require('../infra/config.json');
function template(overrides={}){return Template.fromStack(new PokemonPlayStack(new cdk.App(),config.stackName,{...config,shareDomainName:'',...overrides})).toJSON();}
function resources(t,type){return Object.values(t.Resources).filter(r=>r.Type===type);}
test('private retained S3 and CloudFront OAC serve only HTTPS',()=>{
 const t=template();const bucket=resources(t,'AWS::S3::Bucket')[0];
 assert.equal(bucket.DeletionPolicy,'Retain');assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration,{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true});
 assert.equal(bucket.Properties.OwnershipControls.Rules[0].ObjectOwnership,'BucketOwnerEnforced');
 assert.equal(resources(t,'AWS::CloudFront::OriginAccessControl').length,1);
 const d=resources(t,'AWS::CloudFront::Distribution')[0].Properties.DistributionConfig;
 assert.equal(d.DefaultCacheBehavior.ViewerProtocolPolicy,'redirect-to-https');assert.deepEqual(d.DefaultCacheBehavior.AllowedMethods,['GET','HEAD']);assert.deepEqual(d.Aliases,['pokemon.pir.kr']);
 assert.equal(d.DefaultRootObject,'index.html');assert.ok(!d.CustomErrorResponses);
 assert.equal(resources(t,'AWS::DynamoDB::Table').length,2);assert.equal(resources(t,'AWS::SQS::Queue').length,0);
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
 const routes=resources(t,'AWS::ApiGatewayV2::Route').map(r=>r.Properties.RouteKey).sort();assert.ok(routes.includes('GET /api/rankings')&&routes.includes('POST /api/scores'));assert.equal(routes.length,15);
 const d=resources(t,'AWS::CloudFront::Distribution')[0].Properties.DistributionConfig;
 const behavior=d.CacheBehaviors.find(b=>b.PathPattern==='api/*');assert.ok(behavior);assert.ok(behavior.AllowedMethods.includes('POST'));
 assert.equal(behavior.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
 const execution=resources(t,'AWS::IAM::Policy').find(r=>r.Properties.PolicyName.startsWith('RankingFunction'));
 const data=execution.Properties.PolicyDocument.Statement.find(s=>[].concat(s.Action).includes('dynamodb:GetItem'));assert.deepEqual([].concat(data.Action).sort(),['dynamodb:GetItem','dynamodb:PutItem']);assert.notEqual(data.Resource,'*');
});

test('invitation grants are retained independently and do not expire device records',()=>{
 const t=template(),table=resources(t,'AWS::DynamoDB::Table').find(r=>r.Properties.TableName==='pokemon-play-prod-access');
 assert.equal(table.DeletionPolicy,'Retain');assert.equal(table.UpdateReplacePolicy,'Retain');assert.equal(table.Properties.BillingMode,'PAY_PER_REQUEST');assert.deepEqual(table.Properties.KeySchema,[{AttributeName:'id',KeyType:'HASH'}]);assert.ok(!table.Properties.TimeToLiveSpecification);
 assert.equal(table.Properties.GlobalSecondaryIndexes[0].IndexName,'byKind');
 const pool=resources(t,'AWS::Cognito::UserPool')[0];assert.equal(pool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly,true);assert.equal(pool.DeletionPolicy,'Retain');
 const client=resources(t,'AWS::Cognito::UserPoolClient')[0];assert.equal(client.Properties.GenerateSecret,false);assert.deepEqual(client.Properties.AllowedOAuthFlows,['code']);assert.deepEqual(client.Properties.CallbackURLs,['https://pokemon.pir.kr/admin']);
 const routes=resources(t,'AWS::ApiGatewayV2::Route');for(const route of routes.filter(r=>r.Properties.RouteKey.includes('/api/admin/'))){assert.equal(route.Properties.AuthorizationType,'JWT');assert.deepEqual(route.Properties.AuthorizationScopes,['openid']);}
 assert.equal(routes.filter(r=>r.Properties.RouteKey.includes('/api/admin/')).length,8);
});
test('enabled invitations protect all game assets at the edge while the envelope and administrator shell remain public',()=>{
 const t=template({invitationAccessEnabled:true}),d=resources(t,'AWS::CloudFront::Distribution')[0].Properties.DistributionConfig;
 for(const pattern of ['assets/*','*.html','*.js','*.css','*.json','*.png','*.ico','*.svg','*.webmanifest'])assert.equal(d.CacheBehaviors.find(b=>b.PathPattern===pattern).TrustedKeyGroups.length,1);
 for(const pattern of ['index.html','admin.html','public/*'])assert.ok(!d.CacheBehaviors.find(b=>b.PathPattern===pattern).TrustedKeyGroups);
 assert.ok(d.CacheBehaviors.findIndex(b=>b.PathPattern==='public/*')<d.CacheBehaviors.findIndex(b=>b.PathPattern==='*.js'));
 assert.equal(d.CacheBehaviors.find(b=>b.PathPattern==='api/*').OriginRequestPolicyId,'b689b0a8-53d0-40ab-baf2-68738e2966ac');
 const fn=resources(t,'AWS::Lambda::Function').find(r=>r.Properties.FunctionName==='pokemon-play-prod-rankings');assert.equal(fn.Properties.Environment.Variables.AUTH_REQUIRED,'1');assert.equal(fn.Properties.Environment.Variables.SIGNING_PARAMETER_NAME,'/pokemon-play/prod/cloudfront-signing-key');
 const edge=resources(t,'AWS::CloudFront::Function')[0].Properties.FunctionCode,vm=require('node:vm'),ctx={};vm.createContext(ctx);vm.runInContext(edge,ctx);
 assert.equal(ctx.handler({request:{uri:'/a'.padEnd(44,'a'),headers:{host:{value:'pokemon.pir.kr'}}}}).uri,'/index.html');
 assert.equal(ctx.handler({request:{uri:'/admin',headers:{host:{value:'pokemon.pir.kr'}}}}).uri,'/admin.html');
 for(const uri of ['/game%2ehtml','/public/%2e%2e/game.html','/public/../pokemon.json','/anything-else'])assert.equal(ctx.handler({request:{uri,headers:{host:{value:'pokemon.pir.kr'}}}}).statusCode,404);
 assert.equal(ctx.handler({request:{uri:'/public/access.js',headers:{host:{value:'pokemon.pir.kr'}}}}).uri,'/public/access.js');
});
test('separate share domain redirects onto the main origin before browser storage is used',()=>{
 const t=template({shareDomainName:'pokemin.pir.kr'}),edge=resources(t,'AWS::CloudFront::Function')[0].Properties.FunctionCode,vm=require('node:vm'),ctx={};vm.createContext(ctx);vm.runInContext(edge,ctx);
 const path='/'+ 'a'.repeat(43),result=ctx.handler({request:{uri:path,headers:{host:{value:'pokemin.pir.kr'}}}});assert.equal(result.statusCode,302);assert.equal(result.headers.location.value,'https://pokemon.pir.kr'+path);
 assert.equal(resources(t,'AWS::Route53::RecordSet').length,4);
});
