/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from 'bedrock';
import {randomBytes} from 'crypto';
import * as database from 'bedrock-mongodb';
import {promisify} from 'util';
import {CapabilityAgent} from 'webkms-client';
import * as kms from './kms.js';
const {util: {BedrockError}} = bedrock;
const randomBytesAsync = promisify(randomBytes);

let CACHED_TOKENIZER = null;

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)(['tokenization-tokenizer']);

  await promisify(database.createIndexes)([{
    collection: 'tokenization-tokenizer',
    fields: {'tokenizer.id': 1},
    options: {unique: true, background: false}
  }, {
    collection: 'tokenization-tokenizer',
    fields: {'tokenizer.state': 1},
    options: {unique: false, background: false}
  }, {
    // there can be only one current tokenizer
    collection: 'tokenization-tokenizer',
    fields: {'tokenizer.current': 1},
    options: {
      partialFilterExpression: {'tokenizer.current': {$exists: true}},
      unique: true,
      background: false
    }
  }]);
});

export async function get({} = {}) {
  // 1. Check to see if rotation is required...
  if(_isRotationCheckRequired()) {
    // 1.1. Rotate tokenizer if necessary.
    await _rotateIfNecessary();
  }

  // 2. Get the current tokenizer.
  return _getCurrentTokenizer();
}

export async function deprecate() {
  // mark the `current` tokenizer as deprecated
  const query = {
    'tokenizer.state': 'current'
  };
  const $set = {
    'meta.updated': Date.now(),
    'tokenizer.state': 'deprecated'
  };
  const $unset = {'tokenizer.current': ''};
  const collection = database.collections['tokenization-tokenizer'];
  try {
    const result = await collection.updateOne(
      query, {$set, $unset}, database.writeOptions);
    // return `true` if a tokenizer was marked as `deprecated`
    return result.result.n === 0;
  } catch(e) {
    throw e;
  }
}

function _isRotationCheckRequired() {
  // check for rotation requirements only 20% of the time
  return Math.random() <= 0.2;
}

function _rotateIfNecessary() {
  // TODO: run rotation check (hit database to check for token and
  // document counts since last rotation)
}

async function _getCurrentTokenizer() {
  // 1. Get tokenizer from cache.
  if(CACHED_TOKENIZER) {
    return CACHED_TOKENIZER;
  }

  // 2. Build current tokenizer from database.
  // 2.1. While current tokenizer does not exist, try to create it.
  let record;
  while(!record) {
    // 2.1.1. Try to read the current tokenizer record.
    try {
      record = await _readCurrentTokenizerRecord();
    } catch(e) {
      if(e.name !== 'NotFound') {
        throw e;
      }
    }

    // 2.1.2. If tokenizer record found, break out of loop.
    if(record) {
      break;
    }

    // 2.1.3. Attempt to mark a ready tokenizer as current.
    if(await _markTokenizerAsCurrent()) {
      continue;
    }

    // 2.1.4. Attempt to create a tokenizer to be marked as current.
    await _createTokenizer();
  }

  const {tokenizer} = record;

  // 3. Generate capability agent from handle and secret.
  const handle = 'primary';
  const {secret} = base64url.decode(tokenizer.secret);
  const capabilityAgent = await CapabilityAgent.fromSecret({handle, secret});

  // 4. Get HMAC API.
  const keystore = await kms.getKeystore({id: tokenizer.keystore});
  const keystoreAgent = kms.getKeystoreAgent(
    {capabilityAgent, keystore});
  const hmac = await keystoreAgent.getHmac(tokenizer.hmac);

  // 5. Use tokenizer ID and hmac API to represent current tokenizer.
  const current = {id: tokenizer.id, hmac};

  // 6. Cache tokenizer for faster retrieval.
  if(!CACHED_TOKENIZER) {
    CACHED_TOKENIZER = current;
  }

  // 7. Return current tokenizer.
  return current;
}

async function _readCurrentTokenizerRecord() {
  const query = {'tokenizer.current': true};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenizer'];
  const record = await collection.findOne(query, projection);
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Current tokenizer not found.',
      'NotFoundError', details);
  }
  return record;
}

async function _createTokenizer() {
  // TODO: generate a did:key DID

  // 1. Generate a random secret.
  const secret = await randomBytesAsync(32);
  // 2. Generate capability agent from handle and secret.
  const handle = 'primary';
  const capabilityAgent = await CapabilityAgent.fromSecret({handle, secret});
  // 3. Store the tokenizer record with pending state.
  const collection = database.collections['tokenization-tokenizer'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  const tokenizer = {
    id: capabilityAgent.id,
    secret: base64url.encode(secret),
    state: 'pending'
  };
  let record = {
    meta,
    tokenizer
  };
  try {
    const result = await collection.insert(record, database.writeOptions);
    record = result.ops[0];
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate tokenizer.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }

  // 4. Create a keystore and HMAC key for the tokenizer.
  const keystore = await kms.createKeystore(
    {capabilityAgent, referenceId: 'primary'});
  const keystoreAgent = kms.getKeystoreAgent(
    {capabilityAgent, keystore});
  const key = await keystoreAgent.generateKey(
    {type: 'hmac', kmsModule: bedrock.config.tokenization.kmsModule});

  // 5. Add keystore and HMAC info to the tokenizer record.
  const query = {
    'tokenizer.id': tokenizer.id,
    'tokenizer.state': 'pending'
  };
  const $set = {
    'meta.updated': Date.now(),
    'tokenizer.state': 'ready',
    'tokenizer.keystore': keystore.id,
    'tokenizer.hmac': {
      id: key.id,
      type: key.type
    }
  };
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);
  if(result.result.n === 0) {
    const details = {
      tokenizer: tokenizer.id,
      httpStatusCode: 400,
      public: true
    };
    throw new BedrockError(
      'Could not update tokenizer; ' +
      'tokenizer either not found or in an unexpected state.',
      'InvalidStateError', details);
  }

  // mark a tokenizer as current
  await _markTokenizerAsCurrent();
}

async function _markTokenizerAsCurrent() {
  // mark any `ready` tokenizer as current
  const query = {
    'tokenizer.state': 'ready'
  };
  const $set = {
    'meta.updated': Date.now(),
    'tokenizer.state': 'current',
    'tokenizer.current': true
  };
  const collection = database.collections['tokenization-tokenizer'];
  try {
    const result = await collection.updateOne(
      query, {$set}, database.writeOptions);
    // return `true` if a tokenizer was marked as `current`
    return result.result.n === 0;
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    // return true since a tokenizer was marked as `current` by another process
    return true;
  }
}
