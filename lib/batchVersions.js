/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import assert from 'assert-plus';
import LRU from 'lru-cache';

const {util: {BedrockError}} = bedrock;

// this cache instance will have keys for batchVersion.tokenizerId and
// batchVersion.id or the combination of the two; there is no possibility of a
// keyspace collision on any of these values
const CACHE = new LRU({
  max: 100,
  // 24 hour ttl
  maxAge: 1000 * 60 * 60 * 24,
});

// a special ID, the literal string "NEXT_OPTIONS", is used to identify the
// next set of options to use in the batch options collection; other IDs might
// be used in the future, at present only this ID is used
const BATCH_OPTIONS_ID = 'NEXT_OPTIONS';

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections([
    'tokenization-batchVersion', 'tokenization-batchVersionOptions'
  ]);

  await database.createIndexes([{
    collection: 'tokenization-batchVersion',
    fields: {'batchVersion.id': 1},
    options: {unique: true}
  }, {
    // a tokenizer may have more than one batch version associated with it to
    // allow for changes to batch version options; however, the code must
    // ensure auto-rotation of tokenizers only automatically produces one new
    // batch version
    collection: 'tokenization-batchVersion',
    fields: {'batchVersion.tokenizerId': 1, 'batchVersion.id': -1},
    options: {unique: false}
  }, {
    // there can be only one set of options, used for new versions as
    // they are auto-generated, uses `BATCH_OPTIONS_ID` as the single `id`
    collection: 'tokenization-batchVersionOptions',
    fields: {'batchVersionOptions.id': 1},
    options: {unique: true}
  }]);

  // insert default version options from config, ignoring duplicates
  const options = bedrock.config.tokenization.defaultVersionOptions;
  try {
    await insertOptions({options});
  } catch(e) {
    if(e.name !== 'DuplicateError') {
      throw e;
    }
    // ignore duplicate error, expected condition most of the time
  }
});

export async function create({id, tokenizerId, options}) {
  assert.string(tokenizerId, 'tokenizerId');

  if(!(Number.isInteger(id) && id >= 0)) {
    throw new TypeError('"id" must be a non-negative integer.');
  }
  const collection = database.collections['tokenization-batchVersion'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  const record = {
    meta,
    batchVersion: {
      id,
      tokenizerId,
      options
    }
  };
  try {
    await collection.insertOne(record);
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
  return record;
}

export async function ensureBatchVersion({tokenizerId}) {
  // get latest version associated with tokenizer, creating it as needed
  let batchVersion;
  while(!batchVersion) {
    // optimize for common case where `batchVersion` already exists
    try {
      batchVersion = await get({tokenizerId});
    } catch(e) {
      if(e.name !== 'NotFoundError') {
        throw e;
      }
      // assume tokenizer is new (auto-rotated or initial) and try to create
      // token version for tokenizer (only other cases are database corruption
      // or manual editing)
    }

    if(batchVersion) {
      // `batchVersion` found, break out
      break;
    }

    /* Note: Here we must only create a new version if there is no existing
    version for `tokenizerId`. Since this cannot be enforced by index, we
    enforce it by concurrently getting the latest version ID across all
    tokenizers and the latest for `tokenizerId`. If the version ID for
    `tokenizerId` is `0` and the latest across all tokenizers is for a
    different tokenizer, then we can try to use the next version ID. */
    const [
      {id: lastIdForTokenizerId},
      {id: lastId, tokenizerId: lastTokenizerId},
      optionsRecord
    ] = await Promise.all([
      _getLastVersion({tokenizerId}),
      _getLastVersion(),
      // also fetch options to use if a batch version needs to be created
      getOptions()
    ]);
    if(!(lastIdForTokenizerId === 0 && lastTokenizerId !== tokenizerId)) {
      // loop to get already-created batch version
      continue;
    }

    // get token version options for creating new token version
    const id = lastId + 1;
    const {options} = optionsRecord.batchVersionOptions;
    try {
      batchVersion = await create({id, tokenizerId, options});
    } catch(e) {
      if(e.name !== 'DuplicateError') {
        throw e;
      }
      // another process created the token version, continue to read it
    }
  }
  return batchVersion;
}

/**
 * Gets a token version by either the version id or the tokenizerId.
 *
 * @param {object} options - Options to use.
 * @param {number} [options.id] - An optional version id.
 * @param {string} [options.tokenizerId] - An optional tokenizerId.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @throws {Error} - If neither an id or tokenizerId is provided.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with a database record
 *  object or an ExplainObject if `explain=true`.
 */
export async function get({id, tokenizerId, explain = false} = {}) {
  const query = {};
  if(id === undefined && tokenizerId === undefined) {
    throw new TypeError('Either "id" or "tokenizerId" must be given.');
  }
  if(id !== undefined) {
    if(!(Number.isInteger(id) && id >= 0)) {
      throw new TypeError('"id" must be a non-negative integer.');
    }
    query['batchVersion.id'] = id;
  }
  if(tokenizerId !== undefined) {
    if(typeof tokenizerId !== 'string') {
      throw new TypeError('"tokenizerId" must be a string.');
    }
    query['batchVersion.tokenizerId'] = tokenizerId;
  }

  // cache key needs to cover three cases: tokenizerId-only lookups to find
  // the latest batch version for that tokenizer, id-only lookups to find a
  // batch version for that specific `id`, and id-tokenizerId-lookups to find
  // a specific combination
  let cacheKey;
  if(id !== undefined && tokenizerId !== undefined) {
    cacheKey = `${id}:${tokenizerId}`;
  } else {
    cacheKey = id ?? tokenizerId;
  }

  const cacheResult = CACHE.get(cacheKey);
  if(!explain && cacheResult) {
    return cacheResult;
  }

  const projection = {_id: 0};
  const options = {projection};
  if(tokenizerId !== undefined && id === undefined) {
    // always choose the last / latest version ID when no `id` given
    options.sort = {'batchVersion.tokenizerId': 1, 'batchVersion.id': -1};
  }
  const collection = database.collections['tokenization-batchVersion'];

  if(explain) {
    // 'find().limit(1)' is used here because 'findOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query, options).limit(1);
    return cursor.explain('executionStats');
  }

  const record = await collection.findOne(query, options);
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Token version not found.',
      'NotFoundError', details);
  }

  CACHE.set(cacheKey, record);

  return record;
}

export async function setOptions({options, explain = false} = {}) {
  const collection = database.collections['tokenization-batchVersionOptions'];
  const now = Date.now();
  const batchVersionOptions = {
    id: BATCH_OPTIONS_ID,
    options
  };
  const query = {'batchVersionOptions.id': BATCH_OPTIONS_ID};
  const $set = {batchVersionOptions, 'meta.updated': now};

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.updateOne(query, {
    $set,
    $setOnInsert: {'meta.created': now}
  }, {upsert: true});
  if(result.modifiedCount > 0 || result.upsertedCount > 0) {
    // upserted or modified
    return true;
  }
  // no update, options were identical
  return false;
}

export async function getOptions({explain = false} = {}) {
  const query = {'batchVersionOptions.id': BATCH_OPTIONS_ID};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-batchVersionOptions'];

  if(explain) {
    // 'find().limit(1)' is used here because 'findOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query, {projection}).limit(1);
    return cursor.explain('executionStats');
  }

  const record = await collection.findOne(query, {projection});
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Token version options not found.',
      'NotFoundError', details);
  }
  return record;
}

export async function insertOptions({options}) {
  const collection = database.collections['tokenization-batchVersionOptions'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  const record = {
    meta,
    batchVersionOptions: {
      id: BATCH_OPTIONS_ID,
      options
    }
  };
  try {
    await collection.insertOne(record);
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate token version options.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

export async function _getLastVersion({tokenizerId, explain = false} = {}) {
  const query = {};
  const sort = {};
  if(tokenizerId !== undefined) {
    query['batchVersion.tokenizerId'] = tokenizerId;
    sort['batchVersion.tokenizerId'] = 1;
  }

  const projection = {
    _id: 0, 'batchVersion.id': 1, 'batchVersion.tokenizerId': 1
  };
  sort['batchVersion.id'] = -1;
  const collection = database.collections['tokenization-batchVersion'];

  if(explain) {
    const cursor = await collection.find({}, {projection, sort}).limit(1);
    return cursor.explain('executionStats');
  }

  const record = await collection.findOne(query, {projection, sort});
  if(!record) {
    return {id: 0, tokenizerId: tokenizerId ?? null};
  }
  return {
    id: record.batchVersion.id,
    tokenizerId: record.batchVersion.tokenizerId
  };
}

/**
 * An object containing information on the query plan.
 *
 * @typedef {object} ExplainObject
 */
