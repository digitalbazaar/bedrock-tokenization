/*!
 * Copyright (c) 2020-2023 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import {IdGenerator} from 'bnid';

const {util: {BedrockError}} = bedrock;

// 128 bit random id generator
const idGenerator = new IdGenerator({bitLength: 128});

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['tokenization-pairwiseToken']);

  const indexes = [{
    // `internalId` is a shard key for the pairwise token collection as some
    // resolution parties may resolve most tokens in the system so using the
    // resolution `requester` as a shard key would not shard data well
    collection: 'tokenization-pairwiseToken',
    fields: {
      'pairwiseToken.internalId': 1,
      'pairwiseToken.requester': 1
    },
    options: {unique: true, background: false}
  }];

  // only create TTL expiration records if configured to do so
  const {autoRemoveExpiredRecords} = bedrock.config.tokenization;
  if(autoRemoveExpiredRecords) {
    indexes.push({
      // automatically expire pairwise tokens that have `expires` date field
      collection: 'tokenization-pairwiseToken',
      fields: {'pairwiseToken.expires': 1},
      options: {
        // the `expires` field was optional in previous versions, using a
        // partial filter express accounts for that here
        partialFilterExpression: {'pairwiseToken.expires': {$exists: true}},
        unique: false,
        background: false,
        // grace period of 24 hours; see `documents.js` for grace period note
        expireAfterSeconds: 60 * 60 * 24
      }
    });
  }

  await database.createIndexes(indexes);
});

export async function get({
  internalId, requester, explain = false
} = {}) {
  const query = {
    'pairwiseToken.internalId': internalId,
    'pairwiseToken.requester': requester
  };
  const projection = {_id: 0};
  const collection = database.collections['tokenization-pairwiseToken'];

  if(explain) {
    // 'find().limit(1)' is used here because 'findOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query, {projection}).limit(1);
    return cursor.explain('executionStats');
  }

  let record = await collection.findOne(query, {projection});
  if(record) {
    // explicitly check `expires` against current time to handle cases where
    // the database record just hasn't been expunged yet
    const now = new Date();
    if(record.pairwiseToken.expires && now > record.pairwiseToken.expires) {
      record = null;
    }
  }
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Pairwise token not found.',
      'NotFoundError', details);
  }
  return record;
}

export async function upsert({internalId, requester, expires}) {
  /* Note: Here we optimize for the common case where a pairwise token already
  exists by running an `update` operation and the first `get` operation
  concurrently. We ensure the `update` completes successfully before returning
  the result of the first `get` operation, ensuring that the pairwise token
  record's expiration is updated. If the first `get` operation fails to find
  a result, we create one, looping if another process is running that creates
  one first. */
  const updateOp = _update({internalId, requester, expires}).catch(e => e);

  while(true) {
    try {
      const [record, updateResult] = await Promise.all([
        get({internalId, requester}), updateOp]);
      if(updateResult instanceof Error) {
        throw updateResult;
      }
      return record;
    } catch(e) {
      if(e.name !== 'NotFoundError') {
        throw e;
      }
    }
    // create a pairwise token since one was not found
    try {
      const record = await _create({internalId, requester, expires});
      return record;
    } catch(e) {
      if(e.name !== 'DuplicateError') {
        throw e;
      }
      // duplicate pairwise token resolved concurrently, loop to get it
    }
  }
}

async function _create({internalId, requester, expires}) {
  // generate pairwise token value
  const value = Buffer.from(await idGenerator.generate());

  const collection = database.collections['tokenization-pairwiseToken'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    pairwiseToken: {
      internalId,
      requester,
      value,
      expires
    }
  };
  try {
    const result = await collection.insertOne(record);
    record = result.ops[0];
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate pairwise token.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

async function _update({internalId, requester, expires}) {
  const query = {
    'pairwiseToken.internalId': internalId,
    'pairwiseToken.requester': requester
  };
  const update = {
    $set: {
      'meta.updated': Date.now(),
      'pairwiseToken.expires': expires
    }
  };

  // return `true` if the update occurred
  const collection = database.collections['tokenization-pairwiseToken'];
  const result = await collection.updateOne(query, update);
  return result.result.n !== 0;
}
