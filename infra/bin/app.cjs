const cdk=require('aws-cdk-lib');
const {PokemonPlayStack}=require('../lib/pokemon-play-stack.cjs');
const config=require('../config.json');
new PokemonPlayStack(new cdk.App(),config.stackName,config);
