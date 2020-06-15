/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {IdGenerator, IdEncoder} from 'bnid';
import {randomBytes, timingSafeEqual} from 'crypto';
import * as pLimit from 'p-limit';
import {promisify} from 'util';
import {createKek} from './aeskw.js';
import Bitstring from './Bitstring.js';
import * as tokenizers from './tokenizers.js';
import * as tokenVersions from './tokenVersion.js';
const randomBytesAsync = promisify(randomBytes);
const {util: {BedrockError}} = bedrock;

// initial bitstring for batchIndexSize=1
const BATCH_INDEX_SIZE_1 = 'H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA';

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
    fields: {'pairwiseToken.internalId': 1},
    options: {unique: true, background: false}
  }]);
});

export async function create({
  tokenizer, internalId, attributes, tokenCount
} = {}) {
  // TODO: validate `tokenCount`
  if(!(attributes instanceof Uint8Array)) {
    throw new TypeError('"attributes" must be a Uint8Array.');
  }
  if(attributes.length > 14) {
    throw new TypeError('"attributes" maximum size is 14 bytes.');
  }

  const {id: tokenizerId, hmac} = tokenizer;

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

export async function resolve({requester, token, resolveToInternalId = false}) {
  // parse token
  const {batchId, index} = await _parseToken({token});

  while(true) {
    // get batch document
    const {tokenBatch} = await _getBatch({id: batchId});
    const {internalId} = tokenBatch;

    // special case resolve to internal ID with flag set
    if(resolveToInternalId) {
      return {internalId};
    }

    // do requester-scoped resolution...
    const {resolvedList: encoded, resolution = {}} = tokenBatch;

    // parse resolved bitstring
    const resolvedList = new Bitstring({
      buffer: await Bitstring.decodeBits({encoded})
    });

    // find resolution entry for `requester`
    const encodedRequester = base64url.encode(batchId);
    let entry = resolution[encodedRequester];

    // see if token is already resolved
    if(resolvedList.get(index)) {
      // token already resolved, see if requester matches
      if(entry) {
        const bs = new Bitstring({
          buffer: await Bitstring.decodeBits(entry.list)
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
        buffer: await Bitstring.decodeBits(entry.list)
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
      'tokenBatch.resolvedList': encoded
    };
    const collection = database.collections['tokenization-tokenBatch'];
    const result = collection.updateOne(query, {
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

async function _createToken({
  hmac, tokenVersion, tokenBatch, index, attributes
} = {}) {
  // decode batch ID
  const batchId = base64url.decode(tokenBatch.id);

  // get version options
  const {id: version, batchSaltSize} = tokenVersion;

  // build data to encrypt/wrap: version|batchId|index|aadSize|aad|padding
  // total = 256-bits, 32 bytes
  const toWrap = new Uint8Array(32);
  let dv = new DataView(toWrap.buffer, toWrap.byteOffset, toWrap.length);
  let offset = 0;
  // version, 4 byte uint32
  dv.setUint32(offset += 4, version);
  // batch ID, `batchIdSize`, default is 16 bytes
  toWrap.set(batchId, offset += batchId.length);
  // index, 1 byte
  toWrap[offset += 1] = index;
  // aadSize, 1 byte
  toWrap[offset += 1] = attributes.length;
  // attributes (up to 10 bytes max, but affects token size)
  toWrap.set(attributes, offset += attributes.length);
  // random padding for remaining bytes
  const padding = await randomBytesAsync(32 - offset);
  toWrap.set(padding, offset);

  // generate salt based on token version options
  const salt = await randomBytesAsync(batchSaltSize);

  // create KEK via HMAC(version|salt)
  const kek = await _getKek({hmac, version, salt});

  // wrap `toWrap` as if it were a key
  const wrapped = await kek.wrapKey({unwrappedKey: toWrap});

  // build token: version|salt|wrapped|attributes(aad)
  // example `tokenSize`:
  // 4 bytes: version
  // 16 bytes: salt (larger reduces key collisions, but increases token size)
  // 32 bytes: wrapped data
  // 14 bytes: attributes (max of 14, can be 0 to reduce token by 14 bytes)
  // = 66 byte token max, 52 bytes minimum
  const tokenSize = 4 + salt.length + wrapped.length + attributes.length;
  const token = new Uint8Array(tokenSize);
  dv = new DataView(token.buffer, token.byteOffset, token.length);
  offset = 0;
  // version, 4 byte uint32
  dv.setUint32(offset += 4, version);
  // salt
  token.set(salt, offset += salt.length);
  // wrapped
  token.set(wrapped, offset += wrapped.length);
  // attributes
  token.set(attributes, offset);
}

async function _parseToken({token}) {
  // validate token
  if(!(token instanceof Uint8Array && token.length >= 4)) {
    throw new TypeError(
      '"token" must be a Uint8Array that is 4 bytes or more in size.');
  }

  // parse version from token
  const dv = new DataView(token.buffer, token.byteOffset, token.length);
  let offset = 0;
  const version = dv.getUint32(offset += 4);

  // get token version by `version` ID
  const {tokenVersion} = await tokenVersions.get({id: version});

  // validate token is appropriate size
  // format: version|salt|wrapped|attributes(aad)
  // version = 4 bytes
  // salt = tokenVersion.batchSaltSize bytes
  // wrapped = 32 bytes
  // attributes size only known once `wrapped` is unwrapped
  // Note: `version` and `salt` map to crypto used to generate a key and will
  // therefore be authenticated via key unwrapping. The `attributes` can be
  // compared against the unwrapped attributes to be authenticated as well
  const minimumSize = 4 + tokenVersion.batchSaltSize + 32;
  // 14 bytes is maximum size for attributes
  const maximumSize = minimumSize + 14;
  if(token.length < minimumSize || token.length > maximumSize) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      });
  }

  // parse `salt` and `wrapped` and `attributes`
  offset = token.byteOffset;
  const salt = new Uint8Array(
    token.buffer, offset += tokenVersion.batchSaltSize,
    tokenVersion.batchSaltSize);
  const wrapped = new Uint8Array(token.buffer, offset += 32, 32);
  const attributes = new Uint8Array(
    token.buffer, offset, token.length - minimumSize);

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
  const batchId = new Uint8Array(
    unwrapped.buffer, offset += tokenVersion.batchIdSize,
    tokenVersion.batchIdSize);
  const index = unwrapped[offset++];
  const aadSize = unwrapped[offset++];
  // time-safe compare `aad` against given attributes
  // always use length of *given* `attributes` to determine what to compare
  // and then compare actual lengths thereafter
  const toCompare = new Uint8Array(
    unwrapped.buffer, offset, attributes.length);
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
  const data = new Uint8Array(4 + salt.length);
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let offset = 0;
  dv.setUint32(offset += 4, version);
  data.set(salt, offset);
  // use signature as `key` for wrapping `toWrap`
  const keyData = await hmac.sign({data});
  return createKek({keyData});
}

async function _createBatch({internalId, tokenVersion, tokenCount = 0}) {
  const {options: {batchIdSize, batchTokenCount}} = tokenVersion;

  // generate random batch ID
  const id = base64url.encode(await randomBytesAsync(batchIdSize));

  // create bitstring to store whether individual tokens have been
  // revolved or not
  const resolvedList = await _createEncodedBits();

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
    const result = await collection.insert(record, database.writeOptions);
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
  return collection.findOne(query, projection);
}

async function _getBatch({id}) {
  const query = {'tokenBatch.id': base64url.encode(id)};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenBatch'];
  const record = await collection.findOne(query, projection);
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
    return {tokenBatch, tokenCount: 0};
  }
  // tokens claimed
  const batch = {...tokenBatch, remainingTokenCount: newRemainingTokenCount};
  const startIndex = tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
  return {tokenBatch: batch, startIndex, tokenCount: target};
}

async function _createEncodedBits({batchIndexSize = 1} = {}) {
  // optimize for common cases
  if(batchIndexSize === 1) {
    return BATCH_INDEX_SIZE_1;
  }

  // create bitstring to store whether individual tokens have been
  // revolved or not
  const length = 1 << (batchIndexSize * 8);
  const bitstring = new Bitstring({length});
  return bitstring.encodeBits();
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
    const result = await collection.insert(record, database.writeOptions);
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
  const record = await collection.findOne(query, projection);
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
