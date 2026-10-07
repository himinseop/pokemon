const cdk=require('aws-cdk-lib');
const {PokemonPlayStack}=require('../lib/pokemon-play-stack.cjs');
const config=require('../config.json');
const app=new cdk.App();
const rollout=app.node.tryGetContext('invitationAccessEnabled');
if(rollout!==undefined&&!['true','false',true,false].includes(rollout))throw Error('invitationAccessEnabled must be true or false.');
new PokemonPlayStack(app,config.stackName,{...config,...(rollout===undefined?{}:{invitationAccessEnabled:rollout===true||rollout==='true'})});
