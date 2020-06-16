/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-account');
require('bedrock-express');
require('bedrock-jsonld-document-loader');
require('bedrock-passport');
require('bedrock-permission');
require('bedrock-mongodb');
require('bedrock-tokenization');
require('bedrock-https-agent');
require('bedrock-kms');
require('bedrock-kms-http');
require('bedrock-ssm-mongodb');

require('bedrock-test');
bedrock.start();
