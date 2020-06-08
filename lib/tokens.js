/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {randomBytes} from 'crypto';
import * as pLimit from 'p-limit';
import {promisify} from 'util';
import Bitstring from './Bitstring.js';
import * as tokenVersions from './tokenVersion.js';
const randomBytesAsync = promisify(randomBytes);
const {util: {BedrockError}} = bedrock;

// initial bitstring for batchIndexSize=1
const BATCH_INDEX_SIZE_1 = 'H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA';

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)([
    'tokenization-token', 'tokenization-tokenBatch'
  ]);

  await promisify(database.createIndexes)([{
    // FIXME: placeholder only, use `internalId` in index; it is shard key
    collection: 'tokenization-token',
    fields: {'token.id': 1},
    options: {unique: true, background: false}
  }, {
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.id': 1},
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
  if(attributes.length > 10) {
    throw new TypeError('"attributes" maximum size is 10 bytes.');
  }

  const {id: tokenizerId, hmac} = tokenizer;

  // get version associated with tokenizer, creating it as needed
  const {tokenVersion} = await tokenVersions.upsertVersionForTokenizer(
    {tokenizerId});

  // TODO: probably default batch index size to just 1 byte (256 in a batch)
  // ... more than enough for many use cases
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

export async function resolve({targetId, token}) {
/*
Does *pairwise* resolving if `resolver` is non-null. If `resolver` is `null`
then resolve returns the internal ID for the token. `resolver` must not be
`undefined`.
Once a token is *pairwise* resolved, do not allow it to be resolved again for
another party. This prevents external correlation. Tokens that have been
pairwise resolved must be marked as such by flipping the bit associated with
the token's index in their batch's bitstring.
Optimize for the common case which is that tokens haven't been resolved when
this API is hit, so decode the bitstring for the batch for the token first
and see if it has been resolved -- and if so, only then go about decoding the
pairwise bitstrings associated with any resolving parties to find the correct
one.
*/
}

async function _createToken({
  hmac, tokenVersion, tokenBatch, index, attributes
} = {}) {
  // decode batch ID
  const batchId = base64url.decode(tokenBatch.id);

  // generate salt based on token version options
  const {id: version, batchSaltSize} = tokenVersion;
  const salt = await randomBytesAsync(batchSaltSize);

  // build data to encrypt: vresion|batchId|index|salt|aadSize|aad|padding
  // total = 256-bits, 32 bytes
  const toWrap = new Uint8Array(32);
  let dv = new DataView(toWrap.buffer, toWrap.byteOffset, toWrap.length);
  let offset = 0;
  // version, 4 byte uint32
  dv.setUint32(offset += 4, version);
  // batch ID
  toWrap.set(batchId, offset += batchId.length);
  // index
  toWrap[offset += 1] = index;
  // salt
  toWrap.set(salt, offset += salt.length);
  // aadSize
  toWrap[offset += 1] = attributes.length;
  // attributes
  toWrap.set(attributes, offset += attributes.length);
  // random padding for remaining bytes
  const padding = await randomBytesAsync(32 - offset);
  toWrap.set(padding, offset);

  // key wrap `toWrap`
  // TODO: HMAC(version|salt) to produce kek
  // TODO: use AES-KW to wrap `toWrap`
  const wrapped = new Uint8Array();

  // build token: version|salt|wrapped|attributes(aad)
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

/*
Parameter sizes:
version - 4 bytes (32-bit unsigned integer)
batchId - 16 bytes (128-bits of random)
index - 1 byte (8-bits for up to 256 tokens in a batch)
Don't want indexes to be too large because we need to store usage of them
(using a bitstring) and because larger groups have a greater unwanted
correlation threat
salt - 16 bytes (128-bits of random)
Used to reduce likelihood of same KEK used, not encrypted
Could potentially reduce to 8 bytes at risk of increased likelihood of shared
KEK, but a collision would not necessarily be for the same batch ID causing no
unwanted correlation
aadSize - 1 byte (8-bits to express how large custom attributes are)
additional authenticated data (custom attributes) - up to 10 bytes
We need a byte to indicate how much padding is used vs. actual attributes
kek = hmac(salt) // 32 byte KEK, AES 256-bits, quantum resistant
randomPadding = getRandomBytes(32(256-bits) - 4(version) -
  16(batchId) - 1(index) - 1(aadSize)) // up to 10 bytes of randomPadding
  (whatever is not used by custom attributes)
  // must wrap 256-bits
wrapped = kek.wrap(version|batchId|index|attributes|randomPadding)
token = version|salt|wrapped|attributes(aad)
Size: 4 + 16 + 32 + ~10 = 52 through 62
*/
}

async function _createBatch({internalId, tokenVersion, tokenCount = 0}) {
  const {options: {batchIdSize, batchTokenCount}} = tokenVersion;

  // generate random batch ID
  const id = await randomBytesAsync(batchIdSize);

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

async function _claimTokens({tokenBatch, tokenCount}) {
  const target = Math.min(tokenBatch.remainingTokenCount, tokenCount);
  const query = {
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
