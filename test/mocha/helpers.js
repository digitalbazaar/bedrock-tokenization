/*!
 * Copyright (c) 2020-2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const database = require('bedrock-mongodb');
const {generateId} = require('bnid');

exports.isRegistration = result => {
  console.log('isRegistration', {result});
};

exports.isBatchVersion = (possibleBatchVersion, expectedOptions) => {
  should.exist(possibleBatchVersion);
  possibleBatchVersion.should.be.an('object');
  possibleBatchVersion.should.have.property('meta');
  possibleBatchVersion.meta.should.be.an('object');
  possibleBatchVersion.should.have.property('batchVersion');
  const {batchVersion} = possibleBatchVersion;
  batchVersion.should.be.an('object');
  batchVersion.should.have.property('id');
  batchVersion.id.should.be.a('number');
  batchVersion.should.have.property('tokenizerId');
  batchVersion.tokenizerId.should.be.a('string');
  batchVersion.should.have.property('options');
  batchVersion.options.should.be.an('object');
  if(expectedOptions) {
    batchVersion.options.should.deep.equal(expectedOptions);
  }
};

exports.cleanDB = async ({collectionName}) => {
  await database.collections[collectionName].deleteMany({});
};

exports.insertRecord = async ({record, collectionName}) => {
  const collection = database.collections[collectionName];
  await collection.insertOne(record, database.writeOptions);
};

exports.areTokens = result => {
  should.exist(result);
  result.should.be.an('object');
  result.should.have.property('tokens');
  const {tokens} = result;
  tokens.should.be.an('array');
  tokens.forEach(token => {
    should.exist(token);
    token.should.be.an('Uint8Array');
  });
};

exports.getTokenBatch = async ({internalId}) => {
  const query = {
    'tokenBatch.internalId': internalId
  };
  return database.collections['tokenization-tokenBatch'].findOne(query);
};

// we need to reset the module for most tests
exports.requireUncached = module => {
  delete require.cache[require.resolve(module)];
  return require(module);
};

exports.generateBufferIds = async function(number) {
  const ids = [];
  for(let i = 0; i < number; i++) {
    const bnid = await generateId({
      fixedLength: true
    });
    const base64 = Buffer.from(bnid).toString('base64');
    const id = Buffer.from(base64);
    ids.push(id);
  }
  return ids;
};
