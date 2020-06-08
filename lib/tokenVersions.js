/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {promisify} from 'util';
const {util: {BedrockError}} = bedrock;

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)(['tokenization-tokenVersion']);

  await promisify(database.createIndexes)([{
    collection: 'tokenization-tokenVersion',
    fields: {'tokenVersion.id': 1},
    options: {unique: true, background: false}
  }]);
});

export async function create({id, tokenizerId, batchSize, indexSize}) {
  const collection = database.collections['tokenization-tokenVersion'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    tokenVersion: {
      id,
      options: {
        tokenizerId,
        batchSize,
        indexSize
      }
    }
  };
  try {
    const result = await collection.insert(record, database.writeOptions);
    record = result.ops[0];
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate token version.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
}

export async function get({id}) {
  const query = {'tokenVersion.id': id};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenVersion'];
  const record = await collection.findOne(query, projection);
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Token version not found.',
      'NotFoundError', details);
  }
  return record;
}
