/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {tokenizers} from 'bedrock-tokenizer';
import {IdGenerator, IdEncoder} from 'bnid';
import crypto from 'crypto';
import {randomBytes, timingSafeEqual} from 'crypto';
import assert from 'assert-plus';
import pLimit from 'p-limit';
import {promisify} from 'util';
import {createKek} from './aeskw.js';
import Bitstring from '@digitalbazaar/bitstring';
import * as tokenVersions from './tokenVersions.js';
const randomBytesAsync = promisify(randomBytes);
const {util: {BedrockError}} = bedrock;

// initial bitstring for batchIndexSize=1
const BATCH_INDEX_SIZE_1 = 'H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA';

const VERSION_SIZE = 2;
const UNWRAPPED_SIZE = 24;
const WRAPPED_SIZE = UNWRAPPED_SIZE + 8;
const MAX_AAD_SIZE = 8;
const INTERNAL_ID_SIZE = 16;
const MAX_TOKEN_COUNT = 100;
const MIN_TOKEN_COUNT = 0;

// 128 bit random id generator
const idGenerator = new IdGenerator({bitLength: 128});
// base58, multibase, fixed-length encoder
const idEncoder = new IdEncoder({
  encoding: 'base58',
  fixedLength: true,
  multibase: true
});

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)([
    'tokenization-tokenBatch', 'tokenization-pairwiseToken'
  ]);

  await promisify(database.createIndexes)([{
    // tokens are sharded by batch ID -- can't shard by `internalId` because
    // it will not be known at query time because it is not shared externally
    // and can't make this index unique because the collection is sharded on
    // a field that isn't part of it; however, uniqueness is handled by the
    // index below and by the randomness property of batch IDs
    collection: 'tokenization-tokenBatch',
    // FIXME: may be able to include `tokenVersion.id` in this index, and
    // shrink batch ID size to minimum of 8 bytes if it becomes a shardKey
    // and this becomes a unique index
    fields: {'tokenBatch.id': 1},
    options: {unique: false, background: false}
  }, {
    // `internalId` is a shard key, but we rely upon infeasibly large random
    // batch IDs to ensure uniqueness for batches across `internalId`
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.internalId': 1, 'tokenBatch.id': 1},
    options: {unique: true, background: false}
  }, {
    // `internalId` is a shard key for the pairwise token collection as some
    // resolution parties may resolve most tokens in the system so using the
    // resolution `requester` as a shard key would not shard data well
    collection: 'tokenization-pairwiseToken',
    fields: {
      'pairwiseToken.internalId': 1,
      'pairwiseToken.requester': 1
    },
    options: {unique: true, background: false}
  }]);

  // FIXME: create shard key
});

/**
 * Creates `tokenCount` many unique each bound to the same given `internalId`,
 * having the given authenticated but cleartext `attributes`.
 *
 * To an external (outside of the system using this module) party, each token
 * has a random appearance, but internally (within the system using this module)
 * each token is linked to a particular entity, identified by `internalId`.
 *
 * Tokens are created in "batches", to greatly reduce the amount of space
 * required to store them. This batch information is encoded in the tokens
 * themselves to realize these storage gains. This creates a correlation risk
 * for tokens in the same batch; there is a single unit of correlation (the
 * batch identifier) that indicates that any two tokens in the same batch
 * refer to the same entity. In order to mitigate this risk, the batch
 * information in the token is encrypted using AES-256 (quantum-resistant)
 * encryption. Breaking this type of encryption is considered infeasible in
 * both the near term and forseeable future. However, all encryption should
 * be considered to have a shelf life and the risk of it being broken should
 * be well understood.
 *
 * If the encryption is broken, the `internalId` of the particular entity to
 * which the tokens are internally linked will still not be revealed. However,
 * it will be known that any two tokens with the same batch ID are linked to
 * the same entity. To help further mitigate against any potential threats
 * that may arise from that knowledge, batches can be kept relatively small at
 * an increased cost of storage. The batch size is configurable and may be
 * changed over time -- and it should depend on the use case.
 *
 * The caller of this function may optionally include `attributes` that will
 * appear in the clear in each token. These attributes can be authenticated
 * to ensure they have not changed but will be readable by any external party
 * that sees the token. For this reason, these attributes should never include
 * uniquely identifying information about the entity to which the tokens are
 * linked (as this would defeat the tokenization scheme).
 *
 * Tokens may be "pairwise resolved" *just once* to *one external party*. See
 * the `resolve` function for more details.
 *
 * @param {object} options - Options to use.
 * @param {object} options.tokenizer - The tokenizer instance to use to
 *   create the tokens.
 * @param {string} options.internalId - The internal ID the tokens will be
 *   linked to.
 * @param {Uint8Array} [options.attributes] - Attributes that will be encoded
 *   in each token such that they can be authenticated but also such that
 *   they will appear in the clear for users of the token. Attributes are
 *   expected to be encoded in an application-specific way to fit within a
 *   maximum of 8 bytes.
 * @param {number} options.tokenCount - The number of tokens to create
 *   in this call; note that this is NOT the batch size and that created tokens
 *   may belong to a number of different token batches.
 *
 * @returns {object} An object with `tokens` as an array of created tokens.
 */
export async function create(
  {internalId, attributes = new Uint8Array(), tokenCount} = {}) {
  assert.string(internalId, 'internalId');
  assert.number(tokenCount, 'tokenCount');

  if(!(attributes instanceof Uint8Array)) {
    throw new TypeError('"attributes" must be a Uint8Array.');
  }
  if(attributes.length > MAX_AAD_SIZE) {
    throw new TypeError(`"attributes" maximum size is ${MAX_AAD_SIZE} bytes.`);
  }
  if(internalId.length !== INTERNAL_ID_SIZE) {
    throw new TypeError(`"internalId.length" must be ${INTERNAL_ID_SIZE}.`);
  }
  if(tokenCount > MAX_TOKEN_COUNT || tokenCount <= MIN_TOKEN_COUNT) {
    throw new TypeError(`"tokenCount" must be greater than ${MIN_TOKEN_COUNT}` +
      ` or less than or equal to ${MAX_TOKEN_COUNT}.`);
  }
  // get the current tokenizer and its HMAC API
  const {id: tokenizerId, hmac} = await tokenizers.getCurrent();

  // get version associated with tokenizer, creating it as needed
  const {tokenVersion} = await tokenVersions.ensureTokenVersion(
    {tokenizerId});

  // create tokens with limited concurrency
  // TODO: determine if this is a desirable limitation or if another
  // approach is better
  const {tokenCreationConcurrency: concurrency} = bedrock.config.tokenization;
  const limit = pLimit(concurrency);

  // create tokens until `tokenCount` is reached
  const tokens = [];
  while(tokens.length < tokenCount) {
    // 1. Calculate remaining tokens to issue.
    const target = tokenCount - tokens.length;

    // 2. Get an open batch for creating tokens.
    const {tokenBatch, startIndex, claimedTokenCount} = await _getOpenBatch(
      {internalId, tokenVersion, tokenCount: target});

    // 3. Create tokens in parallel with concurrency limit.
    const promises = [];
    for(let i = 0; i < claimedTokenCount; ++i) {
      const index = startIndex + i;
      promises.push(limit(() => _createToken(
        {hmac, tokenVersion, tokenBatch, index, attributes})));
    }
    const newTokens = await Promise.all(promises);
    tokens.push(...newTokens);
  }

  return {tokens};
}

/**
 * Attempts to resolve the given token to the party identified by `requester`
 * to a pairwise identifier, known as a "pairwise token". Tokens may be
 * "pairwise resolved" *just once* to *one requester*. Once resolved to a
 * requester, it is considered consumed from a resolution perspective; it may
 * not be pairwise resolved to another requester. This restriction helps
 * prevent unwanted correlation.
 *
 * A pairwise identifier is *NOT* the `internalId` (which is never revealed to
 * an external party). Rather, a pairwise identifier will be unique for a
 * combination of an external resolving party (the "requester") and a unique
 * entity. An entity is determined to be unique internally by it having its
 * own `internalId`. This pairwise resolution enables outside parties to
 * have limited correlation capability: it may only correlate entities across
 * all of the tokens it is authorized to resolve.
 *
 * Given the above constraints, an attempt to resolve a token may fail if it
 * has already been resolved by a different requester (or if the token is
 * invalid or expired). If the token has been resolved by the same requester,
 * the same pairwise identifier that was returned during the previous
 * resolution will be returned again.
 *
 * @param {object} options - Options to use.
 * @param {string} options.requester - The a string that unambiguously
 *   identifies the party requesting token resolution.
 * @param {string} options.token - The token to resolve.
 *
 * @returns {object} An object containing the `pairwiseToken`.
 */
export async function resolve({requester, token}) {
  // parse token
  const {batchId, index} = await _parseToken({token});

  while(true) {
    // get batch document
    const {tokenBatch} = await _getBatch({id: batchId});
    const {internalId} = tokenBatch;

    // prepare to do pairwise resolution...
    const {resolvedList: encoded, resolution = {}} = tokenBatch;

    // parse resolved bitstring
    const resolvedList = new Bitstring({
      buffer: await Bitstring.decodeBits({encoded})
    });

    // find resolution entry for `requester`
    const encodedRequester = base64url.encode(requester);
    let entry = resolution[encodedRequester];

    // see if token is already resolved
    if(resolvedList.get(index)) {
      // token already resolved, see if requester matches
      if(entry) {
        const bs = new Bitstring({
          buffer: await Bitstring.decodeBits({encoded: entry.list})
        });
        if(bs.get(index)) {
          // token resolved for same requester, return pairwise token
          const record = await _getPairwiseToken({internalId, requester});
          const {pairwiseToken: {value: pairwiseToken}} = record;
          return {pairwiseToken};
        }
      }
      // token already resolved to another requester, can only be
      // scope-resolved once
      throw new BedrockError(
        'Token already used.',
        'NotAllowedError', {
          public: true,
          httpStatusCode: 400
        });
    }

    // token is not yet resolved, attempt to resolve it for `requester`...

    // create a pairwise token for the requester if one does not exist
    const {pairwiseToken: {value: pairwiseToken}} = await _upsertPairwiseToken(
      {internalId, requester});

    // update requester's resolution info for the token batch
    let bs;
    if(entry) {
      bs = new Bitstring({
        buffer: await Bitstring.decodeBits({encoded: entry.list})
      });
    } else {
      bs = new Bitstring({length: 256});
      entry = resolution[resolution.length] = {requester};
    }
    bs.set(index, true);
    entry.list = await bs.encodeBits();

    // mark token as resolved
    resolvedList.set(index, true);

    // update token batch
    const query = {
      'tokenBatch.id': base64url.encode(batchId),
      // ensure that no change is applied if another process resolved a
      // token concurrently
      'tokenBatch.resolvedList': encoded
    };
    const collection = database.collections['tokenization-tokenBatch'];
    const result = await collection.updateOne(query, {
      $set: {
        'meta.updated': Date.now(),
        'tokenBatch.resolvedList': await resolvedList.encodeBits(),
        [`tokenBatch.resolution.${encodedRequester}`]: entry
      }
    }, database.writeOptions);
    if(result.result.n === 0) {
      // another process resolved a token concurrently, try again
      continue;
    }

    // return new pairwise token
    return {pairwiseToken};
  }
}

/**
 * Resolves a token to the `internalId` to which it is linked. This
 * `internalId` should never be shared outside of the system that uses this
 * module. This function is useful for obtaining the `internalId` associated
 * with a token such that registered, encrypted documents associated with the
 * `internalId` can be retrieved.
 *
 * @param {object} options - Options to use.
 * @param {string} options.token - The token to resolve.
 *
 * @returns {object} An object with the `internalId`.
 */
export async function resolveToInternalId({token}) {
  // parse token
  const {batchId} = await _parseToken({token});

  // get batch document
  const {tokenBatch} = await _getBatch({id: batchId});
  const {internalId} = tokenBatch;

  // special case resolve to internal ID with flag set
  return {internalId};
}

async function _createToken({
  hmac, tokenVersion, tokenBatch, index, attributes
} = {}) {
  // decode batch ID
  const batchId = base64url.decode(tokenBatch.id);

  // get version options
  const {id: version, options: {batchSaltSize}} = tokenVersion;

  // build data to encrypt/wrap: batchId|index|aadSize|aad|padding
  // total = 192-bits, 24 bytes
  const toWrap = new Uint8Array(UNWRAPPED_SIZE);
  let dv = new DataView(toWrap.buffer, toWrap.byteOffset, toWrap.length);
  let offset = 0;
  // batch ID, `batchIdSize`, default is 16 bytes
  toWrap.set(batchId, offset);
  // index, 1 byte
  toWrap[offset += batchId.length] = index;
  // aadSize, 1 byte
  toWrap[offset += 1] = attributes.length;
  // attributes (up to 8 bytes max, but affects token size)
  toWrap.set(attributes, offset += 1);
  // random padding for remaining bytes
  offset += attributes.length;
  const padding = await randomBytesAsync(toWrap.length - offset);
  toWrap.set(padding, offset);

  // generate salt based on token version options
  const salt = await randomBytesAsync(batchSaltSize);

  // create KEK via HMAC(version|salt)
  const kek = await _getKek({hmac, version, salt});

  // wrap `toWrap` as if it were a key, output is 8 more bytes than input
  const wrapped = await kek.wrapKey({unwrappedKey: toWrap});

  // build token: version|salt|wrapped|attributes(aad)
  // example `tokenSize`:
  // 2 bytes: version
  // 16 bytes: salt (larger reduces key collisions, but increases token size)
  // 32 bytes: wrapped data
  // 8 bytes: attributes (max of 8, can be 0 to reduce token by 8 bytes)
  // = 58 byte token max, 50 bytes minimum
  const tokenSize = 2 + salt.length + wrapped.length + attributes.length;
  const token = new Uint8Array(tokenSize);
  dv = new DataView(token.buffer, token.byteOffset, token.length);
  offset = 0;
  // version, 2 byte uint16
  dv.setUint16(offset, version);
  // salt
  token.set(salt, offset += 2);
  // wrapped
  token.set(wrapped, offset += salt.length);
  // attributes
  token.set(attributes, offset += wrapped.length);
  return token;
}

async function _parseToken({token}) {
  // validate token
  if(!(token instanceof Uint8Array && token.length >= VERSION_SIZE)) {
    throw new TypeError(
      `"token" must be a Uint8Array that is ${VERSION_SIZE} bytes ` +
      'or more in size.');
  }

  // parse version from token
  const dv = new DataView(token.buffer, token.byteOffset, token.length);
  const version = dv.getUint16(0);

  // get token version by `version` ID
  const {tokenVersion} = await tokenVersions.get({id: version});
  const {options: {batchIdSize, batchSaltSize}} = tokenVersion;

  // validate token is appropriate size
  // format: version|salt|wrapped|attributes(aad)
  // version = 2 bytes
  // salt = batchSaltSize bytes
  // wrapped = 32 bytes
  // attributes size only known once `wrapped` is unwrapped
  // Note: `version` and `salt` map to crypto used to generate a key and will
  // therefore be authenticated via key unwrapping. The `attributes` can be
  // compared against the unwrapped attributes to be authenticated as well
  const minimumSize = VERSION_SIZE + batchSaltSize + WRAPPED_SIZE;
  // 8 bytes is maximum size for attributes
  const maximumSize = minimumSize + MAX_AAD_SIZE;
  if(token.length < minimumSize || token.length > maximumSize) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      });
  }

  // parse `salt` and `wrapped` and `attributes`
  let offset = token.byteOffset + VERSION_SIZE;
  const salt = new Uint8Array(token.buffer, offset, batchSaltSize);
  const wrapped = new Uint8Array(
    token.buffer, offset += batchSaltSize, WRAPPED_SIZE);
  const attributes = new Uint8Array(
    token.buffer, offset += WRAPPED_SIZE, token.length - minimumSize);
  // get tokenizer associated with version
  const tokenizer = await tokenizers.get({id: tokenVersion.tokenizerId});
  const {hmac} = tokenizer;

  // create KEK via HMAC(version|salt)
  const kek = await _getKek({hmac, version, salt});

  // unwrap `wrapped` as if it were a key
  let unwrapped;
  try {
    unwrapped = await kek.unwrapKey({wrappedKey: wrapped});
    if(unwrapped === null) {
      throw new Error('Decryption failed.');
    }
  } catch(e) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, e);
  }

  // at this point, unwrapped is authenticated and known to be 32 bytes
  // next, determine if full token is valid

  // parse unwrapped: batchId|index|aadSize|aad|padding
  offset = unwrapped.byteOffset;
  const batchId = new Uint8Array(unwrapped.buffer, offset, batchIdSize);
  const index = unwrapped[batchIdSize];
  const aadSize = unwrapped[batchIdSize + 1];
  // time-safe compare `aad` against given attributes
  // always use length of *given* `attributes` to determine what to compare
  // and then compare actual lengths thereafter
  const toCompare = new Uint8Array(
    unwrapped.buffer, offset + batchIdSize + 1, attributes.length);
  if(!(timingSafeEqual(toCompare, attributes) &&
    aadSize === attributes.length)) {
    // cleartext attributes are not authenticated
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      });
  }

  // token authenticated
  return {tokenVersion, tokenizer, batchId, index, attributes};
}

async function _getKek({hmac, version, salt}) {
  // create KEK via HMAC(version|salt)
  const data = new Uint8Array(VERSION_SIZE + salt.length);
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  dv.setUint16(0, version);
  data.set(salt, VERSION_SIZE);
  // use signature as `key` for wrapping `toWrap`
  const keyData = base64url.decode(await hmac.sign({data}));
  return createKek({keyData});
}

async function _createBatch({internalId, tokenVersion, tokenCount = 0}) {
  const {options: {batchIdSize, batchTokenCount}} = tokenVersion;
  const _randomBytesAsync = promisify(crypto.randomBytes);

  // generate random batch ID
  const id = base64url.encode(await _randomBytesAsync(batchIdSize));
  // create bitstring to store whether individual tokens have been
  // revolved or not
  const resolvedList = BATCH_INDEX_SIZE_1;

  // auto-claim tokens in batch
  const remainingTokenCount = Math.max(0, batchTokenCount - tokenCount);

  const collection = database.collections['tokenization-tokenBatch'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    tokenBatch: {
      id,
      internalId,
      tokenVersion: tokenVersion.id,
      resolvedList,
      maxTokenCount: batchTokenCount,
      remainingTokenCount
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
      'Duplicate token batch.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

async function _getOpenBatch({internalId, tokenVersion, tokenCount}) {
  while(true) {
    let record = await _getUnfilledBatch({internalId, tokenVersion});
    if(!record) {
      // no unfilled batch, so create a new batch and claim tokens in it
      record = await _createBatch({internalId, tokenVersion, tokenCount});
      const {tokenBatch} = record;
      const claimedTokenCount =
        tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
      return {tokenBatch, startIndex: 0, claimedTokenCount};
    }

    // try to claim tokens in unfilled batch
    const {tokenBatch} = record;
    const result = await _claimTokens({tokenBatch, tokenCount});
    if(result.claimedTokenCount > 0) {
      return result;
    }
  }
}

async function _getUnfilledBatch({internalId, tokenVersion}) {
  const query = {
    'tokenBatch.internalId': internalId,
    'tokenBatch.tokenVersion': tokenVersion.id,
    'tokenBatch.remainingTokenCount': {$gt: 0}
  };
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenBatch'];
  return collection.findOne(query, {projection});
}

async function _getBatch({id}) {
  const query = {'tokenBatch.id': base64url.encode(id)};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenBatch'];
  const record = await collection.findOne(query, {projection});
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    // error is intentionally "Token not found", does not leak `batch` info
    throw new BedrockError(
      'Token not found.',
      'NotFoundError', details);
  }
  return record;
}

async function _claimTokens({tokenBatch, tokenCount}) {
  const target = Math.min(tokenBatch.remainingTokenCount, tokenCount);
  const query = {
    'tokenBatch.internalId': tokenBatch.internalId,
    'tokenBatch.id': tokenBatch.id,
    'tokenBatch.remainingTokenCount': tokenBatch.remainingTokenCount
  };
  const newRemainingTokenCount = tokenBatch.remainingTokenCount - target;
  const $set = {
    'meta.updated': Date.now(),
    'tokenBatch.remainingTokenCount': newRemainingTokenCount
  };
  const collection = database.collections['tokenization-tokenBatch'];
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);
  if(result.result.n === 0) {
    // could not claim tokens
    return {tokenBatch, claimedTokenCount: 0};
  }
  // tokens claimed
  const batch = {...tokenBatch, remainingTokenCount: newRemainingTokenCount};
  const startIndex = tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
  return {tokenBatch: batch, startIndex, claimedTokenCount: target};
}

async function _upsertPairwiseToken({internalId, requester}) {
  while(true) {
    // default to getting pairwise token first assuming that the common case
    // is that the requester has resolved a token for `internalId` before
    try {
      const record = await _getPairwiseToken({internalId, requester});
      return record;
    } catch(e) {
      if(e.name !== 'NotFoundError') {
        throw e;
      }
    }
    // create a pairwise token since one was not found
    try {
      const record = await _createPairwiseToken({internalId, requester});
      return record;
    } catch(e) {
      if(e.name !== 'DuplicateError') {
        throw e;
      }
      // duplicate pairwise token resolved concurrently, loop to get it
    }
  }
}

async function _createPairwiseToken({internalId, requester}) {
  // generate pairwise token value
  const value = idEncoder.encode(await idGenerator.generate());

  // FIXME: pairwise tokens should expire, need to handle `ttl` cleanly
  const collection = database.collections['tokenization-pairwiseToken'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    pairwiseToken: {
      internalId,
      requester,
      value
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
      'Duplicate pairwise token.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

async function _getPairwiseToken({internalId, requester}) {
  const query = {
    'pairwiseToken.internalId': internalId,
    'pairwiseToken.requester': requester
  };
  const projection = {_id: 0};
  const collection = database.collections['tokenization-pairwiseToken'];
  const record = await collection.findOne(query, {projection});
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
