/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {config} = require('bedrock');
const path = require('path');

config.mocha.tests.push(path.join(__dirname, 'mocha'));

// mongodb config
config.mongodb.name = 'bedrock_tokenization_test';
config.mongodb.host = 'localhost';
config.mongodb.port = 27017;
config.mongodb.local.collection = 'bedrock_tokenization_test';
// drop all collections on initialization
config.mongodb.dropCollections = {};
config.mongodb.dropCollections.onInit = true;
config.mongodb.dropCollections.collections = [];

// HTTPS Agent
config['https-agent'].rejectUnauthorized = false;

// KMS
config.kms.allowedHost = config.server.host;

// KMS HTTPS API
// optionally require an authenticated session
// this option may be set to false when operating behind an authenticated proxy
config['kms-http'].requireAuthentication = false;
