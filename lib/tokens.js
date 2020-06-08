/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {randomBytes} from 'crypto';
import {promisify} from 'util';
import Bitstring from './Bitstring.js';
import * as tokenVersions from './tokenVersion.js';
const randomBytesAsync = promisify(randomBytes);
const {util: {BedrockError}} = bedrock;

// initial bitstring for batchIndexSize=1
const BATCH_INDEX_SIZE_1 = 'H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA';

// initial bitstring for batchIndexSize=2
const BATCH_INDEX_SIZE_2 =
  'H4sIAAAAAAAAA-3BAQ0AAADCoPdPbQ43oAAAAAAAAACAdwOUmfTYACAAAA';

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)([
    'tokenization-token', 'tokenization-tokenBatch'
  ]);

  await promisify(database.createIndexes)([{
    collection: 'tokenization-token',
    fields: {'token.id': 1},
    options: {unique: true, background: false}
  }, {
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.id': 1},
    options: {unique: true, background: false}
  }]);
});

export async function create({tokenizer, internalId, attributes, count} = {}) {
/*
Create `count` pseudorandom tokens with embedded attributes `attributes` that
all map to `internalId`.
*/
  // TODO: validate `count`

  const {id: tokenizerId, hmac} = tokenizer;

  // get version associated with tokenizer, creating it as needed
  const {tokenVersion} = await tokenVersions.upsertVersionForTokenizer(
    {tokenizerId});
  const {id: version} = tokenVersion;

  // TODO: probably default batch index size to just 1 byte (256 in a batch)
  // ... more than enough for many use cases

  // TODO: include size of batch in batch record
  // TODO: include counter for number of tokens issued so far
  // TODO: have index on `internalId` (shard key) + number of tokens
  // TODO: so far/remaining tokens ... so we can do a query to find a
  //       batch with some remaining tokens to issue
  // TODO: create a loop that finds batches to issue from and then creates
  //       more as needed
  // TODO: determine where to set the max number of tokens in a batch...
  //       in the version options probably.

  // create a batch record
  const batch = await _createBatch({internalId, tokenVersion});

  // TODO: use p-* promises-fun to limit concurrency as needed
  for(let i = 0; i < count; ++i) {
    _create({hmac, version, batch, attributes})
    //hmac, version, salt, batchId, index, attributes
  }
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

// FIXME: API params to change
async function _create({
  hmac, version, salt, batchId, index, attributes
} = {}) {
/*
Note: `hmac` could be looked up by `version` but will be more optimal to pass
it in given that this look up will be repeated. We could cache it as well but
we'd need to ensure cache misses were serialized waiting on a single call to
`tokenVersions.get()`.
Parameter sizes:
version - 4 bytes (32-bit unsigned integer)
batchId - 16 bytes (128-bits of random)
index - 2 bytes (16-bits for up to 65536 tokens in a batch)
Don't want indexes to be too large because we need to store usage of them
(using a bitstring) and because larger groups have a greater unwanted
correlation threat
additional authenticated data (custom attributes) - 10 bytes
We need a byte to indicate how much padding is used vs. actual attributes
salt - 16 bytes (128-bits of random)
Used to reduce likelihood of same KEK used, not encrypted
Could potentially reduce to 8 bytes at risk of increased likelihood of shared
KEK, but a collision would not necessarily be for the same batch ID causing no
unwanted correlation
kek = hmac(salt) // 32 byte KEK, AES 256-bits, quantum resistant
randomPadding = getRandomBytes(32(256-bits) - 4(version) -
  16(batchId) - 2(index)) // up to 10 bytes of randomPadding (whatever is not
  used by custom attributes)
  // must wrap 256-bits
wrapped = kek.wrap(version|batchId|index|attributes|randomPadding)
token = version|salt|wrapped|attributes(aad)
Size: 4 + 16 + 32 + 10 = 62
*/
}

async function _createBatch({internalId, tokenVersion}) {
  const {options: {batchIdSize, batchIndexSize, batchTokenCount}} =
    tokenVersion;

  // generate random batch ID
  const id = await randomBytesAsync(batchIdSize);

  // create bitstring to store whether individual tokens have been
  // revolved or not
  const resolvedList = await _createEncodedBits({batchIndexSize});

  const collection = database.collections['tokenization-tokenBatch'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  let record = {
    meta,
    tokenBatch: {
      id,
      internalId,
      resolvedList
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

async function _createEncodedBits({batchIndexSize}) {
  // optimize for common cases
  if(batchIndexSize === 1) {
    return BATCH_INDEX_SIZE_1;
  }
  if(batchIndexSize === 2) {
    return BATCH_INDEX_SIZE_2;
  }

  // create bitstring to store whether individual tokens have been
  // revolved or not
  const length = 1 << (batchIndexSize * 8);
  const bitstring = new Bitstring({length});
  return bitstring.encodeBits();
}
