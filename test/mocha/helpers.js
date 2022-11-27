/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as database from '@bedrock/mongodb';

export function isRegistration(result) {
  //console.log('isRegistration', {result});
  should.exist(result);
}

export function isBatchVersion(possibleBatchVersion, expectedOptions) {
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
}

export async function cleanDB({collectionName}) {
  await database.collections[collectionName].deleteMany({});
}

export async function insertRecord({record, collectionName}) {
  const collection = database.collections[collectionName];
  await collection.insertOne(record);
}

export function areTokens(result) {
  should.exist(result);
  result.should.be.an('object');
  result.should.have.property('tokens');
  const {tokens} = result;
  tokens.should.be.an('array');
  tokens.forEach(token => {
    should.exist(token);
    token.should.be.an('Uint8Array');
  });
}

export async function getTokenBatch({internalId}) {
  const query = {
    'tokenBatch.internalId': internalId
  };
  return database.collections['tokenization-tokenBatch'].findOne(query);
}
