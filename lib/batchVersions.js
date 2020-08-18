/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {promisify} from 'util';
const {util: {BedrockError}} = bedrock;
import LRU from 'lru-cache';

// this cache instance will have keys for batchVersion.tokenizerId and
// batchVersion.id, there is no possibility of a keyspace collision on these
// values
const CACHE = new LRU({
  max: 20,
  // 24 hour ttl
  maxAge: 1000 * 60 * 60 * 24,
});

const BATCH_OPTIONS_ID = 'NEXT_OPTIONS';

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)([
    'tokenization-batchVersion', 'tokenization-batchVersionOptions'
  ]);

  await promisify(database.createIndexes)([{
    collection: 'tokenization-batchVersion',
    fields: {'batchVersion.id': 1},
    options: {unique: true, background: false}
  }, {
    // do not reuse a tokenizer across multiple versions to ensure
    // version creation can be automated when tokenizers auto-rotate
    collection: 'tokenization-batchVersion',
    fields: {'batchVersion.tokenizerId': 1},
    options: {unique: true, background: false}
  }, {
    // there can be only one set of options, used for new versions as
    // they are auto-generated, uses `BATCH_OPTIONS_ID` as the single `id`
    collection: 'tokenization-batchVersionOptions',
    fields: {'batchVersionOptions.id': 1},
    options: {unique: true, background: false}
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
  if(!id) {
    // get next version ID
    id = await _getNextVersionId();
  }
  const collection = database.collections['tokenization-batchVersion'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    batchVersion: {
      id,
      tokenizerId,
      options
    }
  };
  try {
    const result = await collection.insertOne(record, database.writeOptions);
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

export async function ensureBatchVersion({tokenizerId}) {
  // get version associated with tokenizer, creating it as needed
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

    // get token version options for creating new token version
    const record = await getOptions();
    const {options} = record.batchVersionOptions;
    try {
      batchVersion = await create({tokenizerId, options});
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
 *
 * @throws {Error} - If neither an id or tokenizerId is provided.
 *
 * @returns {object} A tokenizerVersion object.
 */
export async function get({id, tokenizerId}) {
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

  const cacheKey =
    query['batchVersion.tokenizerId'] || query['batchVersion.id'];
  const cacheResult = CACHE.get(cacheKey);
  if(cacheResult) {
    return cacheResult;
  }

  const projection = {_id: 0};
  const collection = database.collections['tokenization-batchVersion'];
  const record = await collection.findOne(query, {projection});
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

export async function setOptions({options}) {
  const collection = database.collections['tokenization-batchVersionOptions'];
  const now = Date.now();
  const batchVersionOptions = {
    id: BATCH_OPTIONS_ID,
    options
  };
  const query = {'batchVersionOptions.id': BATCH_OPTIONS_ID};
  const $set = {batchVersionOptions, 'meta.updated': now};
  const upsertOptions = {...database.writeOptions, upsert: true};
  const result = await collection.updateOne(query, {
    $set,
    $setOnInsert: {'meta.created': now}
  }, upsertOptions);
  if(result.result.n > 0) {
    // upserted or modified
    return true;
  }
  // no update, options were identical
  return false;
}

export async function getOptions() {
  const query = {'batchVersionOptions.id': BATCH_OPTIONS_ID};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-batchVersionOptions'];
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
  let record = {
    meta,
    batchVersionOptions: {
      id: BATCH_OPTIONS_ID,
      options
    }
  };
  try {
    const result = await collection.insertOne(record, database.writeOptions);
    record = result.ops[0];
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

async function _getNextVersionId() {
  const projection = {_id: 0, 'batchVersion.id': 1};
  const sort = {id: -1};
  const collection = database.collections['tokenization-batchVersion'];
  const records = await collection.find(
    {}, {projection, sort}).toArray();
  if(records.length === 0) {
    return 0;
  }
  return records[0].batchVersion.id + 1;
}
