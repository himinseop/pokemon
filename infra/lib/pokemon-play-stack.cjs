const cdk=require('aws-cdk-lib');
const {aws_s3:s3,aws_cloudfront:cloudfront,aws_cloudfront_origins:origins,aws_certificatemanager:acm,aws_route53:route53,aws_route53_targets:targets,aws_iam:iam}=cdk;
function validateConfig(config){
 if(!/^\d{12}$/.test(config.account)||!/^ap-northeast-2$/.test(config.region))throw Error('AWS 계정과 서울 리전을 확인하세요.');
 if(!/^[a-z0-9-]+\.pir\.kr$/.test(config.domainName)||config.zoneName!=='pir.kr'||!/^Z[A-Z0-9]+$/.test(config.hostedZoneId))throw Error('도메인과 기존 Route 53 영역을 확인하세요.');
 if(!/^[A-Za-z][A-Za-z0-9-]+$/.test(config.stackName))throw Error('스택 이름이 잘못됐습니다.');
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.githubRepository)||!/^\d+$/.test(config.githubOwnerId)||!/^\d+$/.test(config.githubRepositoryId)||config.githubEnvironment!=='production')throw Error('GitHub 저장소와 고유 ID, production 환경을 확인하세요.');
 if(config.githubOidcProviderArn&&config.githubOidcProviderArn!==`arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`)throw Error('같은 계정의 GitHub OIDC Provider ARN만 사용할 수 있습니다.');
 if(config.certificateArn&&!new RegExp(`^arn:aws:acm:us-east-1:${config.account}:certificate/[a-f0-9-]+$`).test(config.certificateArn))throw Error('같은 계정 us-east-1 인증서가 필요합니다.');
 return config;
}
class PokemonPlayStack extends cdk.Stack{
 constructor(scope,id,config,props={}){
  validateConfig(config);super(scope,id,{...props,env:{account:config.account,region:config.region},terminationProtection:true,description:'Pokemon static quiz, S3 OAC and GitHub Actions deployment'});
  const zone=route53.HostedZone.fromHostedZoneAttributes(this,'PirKrZone',{hostedZoneId:config.hostedZoneId,zoneName:config.zoneName});
  const certificate=config.certificateArn?acm.Certificate.fromCertificateArn(this,'Certificate',config.certificateArn):new acm.DnsValidatedCertificate(this,'Certificate',{domainName:config.domainName,hostedZone:zone,region:'us-east-1',cleanupRoute53Records:false});
  const bucket=new s3.Bucket(this,'WebBucket',{blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,objectOwnership:s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,enforceSSL:true,encryption:s3.BucketEncryption.S3_MANAGED,removalPolicy:cdk.RemovalPolicy.RETAIN,autoDeleteObjects:false});
  const cache=new cloudfront.CachePolicy(this,'StaticCache',{minTtl:cdk.Duration.seconds(0),defaultTtl:cdk.Duration.minutes(1),maxTtl:cdk.Duration.days(365),enableAcceptEncodingGzip:true,enableAcceptEncodingBrotli:true,cookieBehavior:cloudfront.CacheCookieBehavior.none(),headerBehavior:cloudfront.CacheHeaderBehavior.none(),queryStringBehavior:cloudfront.CacheQueryStringBehavior.none()});
  const distribution=new cloudfront.Distribution(this,'Distribution',{defaultRootObject:'index.html',domainNames:[config.domainName],certificate,minimumProtocolVersion:cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,priceClass:cloudfront.PriceClass.PRICE_CLASS_200,enableLogging:false,defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(bucket),viewerProtocolPolicy:cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,allowedMethods:cloudfront.AllowedMethods.ALLOW_GET_HEAD,compress:true,cachePolicy:cache,responseHeadersPolicy:cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS}});
  const recordName=config.domainName.slice(0,-(config.zoneName.length+1));
  new route53.ARecord(this,'AliasA',{zone,recordName,target:route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))});
  new route53.AaaaRecord(this,'AliasAAAA',{zone,recordName,target:route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution))});
  const provider=config.githubOidcProviderArn?iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this,'GitHubOidcProvider',config.githubOidcProviderArn):new iam.OpenIdConnectProvider(this,'GitHubOidcProvider',{url:'https://token.actions.githubusercontent.com',clientIds:['sts.amazonaws.com']});
  const [owner,repository]=config.githubRepository.split('/');
  const subjects=[`repo:${config.githubRepository}:environment:${config.githubEnvironment}`,`repo:${owner}@${config.githubOwnerId}/${repository}@${config.githubRepositoryId}:environment:${config.githubEnvironment}`];
  const role=new iam.Role(this,'GitHubDeployRole',{roleName:'pokemon-play-prod-github-deploy',maxSessionDuration:cdk.Duration.hours(1),description:'Only publish Pokemon static files and invalidate its CloudFront cache',assumedBy:new iam.FederatedPrincipal(provider.openIdConnectProviderArn,{StringEquals:{'token.actions.githubusercontent.com:aud':'sts.amazonaws.com','token.actions.githubusercontent.com:sub':subjects}},'sts:AssumeRoleWithWebIdentity')});
  role.addToPolicy(new iam.PolicyStatement({actions:['s3:ListBucket','s3:GetBucketLocation'],resources:[bucket.bucketArn]}));
  role.addToPolicy(new iam.PolicyStatement({actions:['s3:GetObject','s3:PutObject'],resources:[bucket.arnForObjects('*')]}));
  role.addToPolicy(new iam.PolicyStatement({actions:['cloudfront:CreateInvalidation','cloudfront:GetInvalidation'],resources:[`arn:aws:cloudfront::${config.account}:distribution/${distribution.distributionId}`]}));
  role.addToPolicy(new iam.PolicyStatement({actions:['cloudformation:DescribeStacks'],resources:[`arn:aws:cloudformation:${config.region}:${config.account}:stack/${config.stackName}/*`]}));
  for(const [key,value] of Object.entries({SiteUrl:`https://${config.domainName}`,WebBucketName:bucket.bucketName,DistributionId:distribution.distributionId,DistributionDomain:distribution.distributionDomainName,GitHubDeployRoleArn:role.roleArn}))new cdk.CfnOutput(this,key,{value});
  cdk.Tags.of(this).add('Project','pokemon-play');cdk.Tags.of(this).add('Environment','production');
 }
}
module.exports={PokemonPlayStack,validateConfig};
