/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import assert from 'assert-plus';
import * as base58 from 'base58-universal';
import * as base64url from 'base64url-universal';
import * as batchVersions from './batchVersions.js';
import * as bedrock from 'bedrock';
import {createKek} from './aeskw.js';
import crypto from 'crypto';
import * as database from 'bedrock-mongodb';
import * as documents from './documents.js';
import {encode as cborldEncode, decode as cborldDecode} from
  '@digitalbazaar/cborld';
import {tokenizers} from 'bedrock-tokenizer';
import pLimit from 'p-limit';
import {promisify} from 'util';
import Bitstring from '@digitalbazaar/bitstring';
import {IdGenerator} from 'bnid';
import {constants as citConstants, appContextMap, documentLoader}
  from 'cit-context';
const {CIT_CONTEXT_URL} = citConstants;

const {util: {BedrockError}} = bedrock;
const {randomBytes, timingSafeEqual} = crypto;
const randomBytesAsync = promisify(randomBytes);

// initial bitstring for batchIndexSize=1
const BATCH_INDEX_SIZE_1 = Buffer.from(
  base64url.decode('H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA'));

const VERSION_SIZE = 2;
const INTERNAL_ID_SIZE = 16;
const MAX_TOKEN_COUNT = 100;
const MIN_TOKEN_COUNT = 0;

// 128 bit random id generator
const idGenerator = new IdGenerator({bitLength: 128});

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)([
    'tokenization-tokenBatch', 'tokenization-openTokenBatch',
    'tokenization-pairwiseToken'
  ]);

  await promisify(database.createIndexes)([{
    /* Note: The `tokenBatch` collection should be sharded by `tokenBatch.id`.
    This collection stores the batch information and is separate from the
    `openTokenBatch` collection that just tracks which batches are unfilled
    (more tokens can still be issued from them). These collections are
    independent because they require different sharding characteristics to
    support different queries. The `tokenBatch` query must support look ups
    on *only* the `tokenBatch.id` so this must be its shard key. */
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.id': 1},
    options: {unique: true, background: false}
  }, {
    // This does not include the shard key. This is not expected to be ran in
    // the hottest code paths, so we are taking a "scatter-gather" approach
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.internalId': 1},
    options: {background: false}
  }, {
    // the `openTokenBatch` collection must support look ups on `internalId`
    // without any token batch ID, so its shard key is only `internalId`; see
    // above note on `tokenBatch` collection index for more details
    collection: 'tokenization-openTokenBatch',
    // not including `tokenBatch` as an object to nest `internalId` in is
    // intentional, we're only tracking `internalId` and `batchId` in
    // this collection
    fields: {internalId: 1, batchId: 1},
    options: {unique: true, background: false}
  }, {
    // automatically expire token batches with an `expires` date field
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.expires': 1},
    options: {
      unique: false,
      background: false,
      expireAfterSeconds: 0
    }
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
});

/**
 * Safely registers a `document` and creates tokens concurrently. Use this
 * call to optimize workflows that always involve registering a document
 * and then creating tokens for it.
 *
 * See `documents.register` and `tokens.create` for additional information.
 *
 * @param {object} options - Options to use.
 * @param {object} options.registerOptions - The document register options.
 * @param {Uint8Array} [options.attributes] - Attributes that will be encoded
 *   in each token such that they can be authenticated but also such that
 *   they will appear in the clear for users of the token. Attributes are
 *   expected to be encoded in an application-specific way; every 8 bytes
 *   of attributes increases the token size by 8 bytes, i.e., 7 bytes of
 *   attributes will not increase the token size, but 8-15 will increase it by
 *   8 bytes and 16-23 will increase it by 16, and so on.
 * @param {number} options.tokenCount - The number of tokens to create
 *   in this call; note that this is NOT the batch size and that created tokens
 *   may belong to a number of different token batches.
 *
 * @returns {Promise<object>} An object with `registrationRecord` as the
 *   resulting registration record and `tokens` as an array of created tokens.
 */
export async function registerDocumentAndCreate(
  {registerOptions, attributes = new Uint8Array(), tokenCount} = {}) {
  assert.object(registerOptions, 'registerOptions');
  assert.number(tokenCount, 'tokenCount');

  /* Note: This function will attempt to concurrently register a document
  and create some number of tokens. It exists as an optimization for common
  workflows where a registration is always attempted prior to creating some
  tokens to associate with it. Waiting for the registration to complete before
  starting to create a token batch can cause unnecessary latency for these
  workflows since, nearly all of the time, an optimistic attempt at performing
  the registration and the token creation in parallel would be successful.
  This is particularly true if the database backend systems require replication
  before the writes are considered safe.

  If a document registration fails while the tokens are being created, the
  outcome will be that additional unused tokens will live in the database
  until they expire. As registrations can only fail due to database errors
  and the same database is used for both tokens and registrations, a case
  where tokens can be created but registrations cannot is predicted to be
  rare. Care should still be taken to ensure these scenarios do not occur,
  as they will result in producing unusable tokens that take up space in
  the database. Care should also be taken to ensure that an attacker cannot
  exploit this outcome.

  Another degenerate case to consider may occur because a check must be made to
  find an existing `internalId` to use in the token creation process. When the
  calls are made in serial, the `internalId` is the result of the registration
  process -- but that cannot be done here. This means that a concurrent
  process may insert a registration for the document using a different
  `internalId` (despite this being very rare for workflows, it is possible).
  To account for this degenerate case, we must check to see that the
  `internalId` returned from the `register` call matches the `internalId`
  generated/reused in the token creation process. Note that it is also
  possible, though unlikely, for a registration record to expire after the
  registration record query -- and another process could insert a new one
  prior to the reuse of `internalId` from the query. In both cases the remedy
  is the same: Simply rerun the entire call -- hence the `while` loop. The
  tokens generated for the unused `internalId` will never leave the system,
  the `internalId` is infeasibly large to guess or be used again by
  another user, and, even if used again, it would not be different from a user
  who had lost some of their old tokens. */

  // tokenize registration information
  const {externalId, document, creator} = registerOptions;
  const {tokenizer, externalIdHash, documentHash, creatorHash} =
    await documents._tokenizeRegistration({externalId, document, creator});

  while(true) {
    // try to obtain an existing `internalId` for the given registration options
    let registrationRecord;
    try {
      registrationRecord = await documents._getRegistrationRecord(
        {externalIdHash, documentHash});
    } catch(e) {
      // only swallow not found errors
      if(e.name !== 'NotFoundError') {
        throw e;
      }
    }

    // reuse or generate an `internalId`
    const internalId = registrationRecord ?
      registrationRecord.registration.internalId :
      await documents._generateInternalId();

    // optimistically attempt registration and token creation in parallel
    const [registrationResult, createResult] = await Promise.all([
      documents.register({
        ...registerOptions,
        internalId,
        tokenizer, externalIdHash, documentHash, creatorHash,
        newRegistration: !registrationRecord
      }),
      create({internalId, attributes, tokenCount})
    ]);

    // if `internalId` does not match, then we must try again
    if(registrationResult.registration.internalId.compare(internalId) !== 0) {
      continue;
    }

    // return result(s)
    return {registrationRecord: registrationResult, ...createResult};
  }
}

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
 * @param {Buffer} options.internalId - The internal ID the tokens will be
 *   linked to.
 * @param {Uint8Array} [options.attributes] - Attributes that will be encoded
 *   in each token such that they can be authenticated but also such that
 *   they will appear in the clear for users of the token. Attributes are
 *   expected to be encoded in an application-specific way; every 8 bytes
 *   of attributes increases the token size by 8 bytes, i.e., 7 bytes of
 *   attributes will not increase the token size, but 8-15 will increase it by
 *   8 bytes and 16-23 will increase it by 16, and so on.
 * @param {number} options.tokenCount - The number of tokens to create
 *   in this call; note that this is NOT the batch size and that created tokens
 *   may belong to a number of different token batches.
 * @param {number} options.minAssuranceForResolution - Minimum level of
 *   assurance required for token resolution.
 *
 * @returns {object} An object with `tokens` as an array of created tokens.
 */
export async function create({
  internalId, attributes = new Uint8Array(), tokenCount,
  minAssuranceForResolution
} = {}) {
  assert.buffer(internalId, 'internalId');
  assert.number(tokenCount, 'tokenCount');

  if(!(attributes instanceof Uint8Array)) {
    throw new TypeError('"attributes" must be a Uint8Array.');
  }
  if(internalId.length !== INTERNAL_ID_SIZE) {
    throw new RangeError(`"internalId.length" must be ${INTERNAL_ID_SIZE}.`);
  }
  if(tokenCount > MAX_TOKEN_COUNT || tokenCount <= MIN_TOKEN_COUNT) {
    throw new RangeError(`"tokenCount" must be greater than ` +
      `${MIN_TOKEN_COUNT} or less than or equal to ${MAX_TOKEN_COUNT}.`);
  }
  // get the current tokenizer and its HMAC API
  const {id: tokenizerId, hmac} = await tokenizers.getCurrent();

  // get version associated with tokenizer, creating it as needed
  const {batchVersion} = await batchVersions.ensureBatchVersion(
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
    const {tokenBatch, startIndex, claimedTokenCount} = await _getOpenBatch({
      internalId, batchVersion, tokenCount: target, minAssuranceForResolution
    });

    // 3. Create tokens in parallel with concurrency limit.
    const promises = [];
    for(let i = 0; i < claimedTokenCount; ++i) {
      const index = startIndex + i;
      promises.push(limit(() => _createToken(
        {hmac, batchVersion, tokenBatch, index, attributes})));
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
 * @param {string} options.requester - The string that unambiguously
 *   identifies the party requesting token resolution.
 * @param {Buffer} options.token - Decoded scoped token to resolve.
 * @param {number} options.levelOfAssurance - Level of assurance provided
 *   during token presentation.
 *
 * @returns {object} An object containing the Uint8Array `pairwiseToken`.
 */
export async function resolve({requester, token, levelOfAssurance}) {
  // parse token
  const {batchId, index} = await _parseToken({token});

  while(true) {
    // get batch document
    const {tokenBatch} = await _getBatch({id: batchId});
    if(tokenBatch.invalid) {
      throw new BedrockError(
        'Token has been invalidated.',
        'NotAllowedError', {
          public: true,
          httpStatusCode: 403
        });
    }
    const {internalId} = tokenBatch;

    // compare the levelOfAssurance passed in to the minAssuranceForResolution
    // on the existing tokens
    if(levelOfAssurance < tokenBatch.minAssuranceForResolution) {
      throw new BedrockError(
        'Could not resolve token; minimum level of assurance not met.',
        'NotAllowedError', {
          levelOfAssurance,
          minAssuranceForResolution: tokenBatch.minAssuranceForResolution,
          public: true,
          httpStatusCode: 403
        });
    }

    // prepare to do pairwise resolution...
    const {resolvedList: compressed, resolution = {}} = tokenBatch;

    // parse resolved bitstring
    const resolvedList = new Bitstring({
      buffer: await Bitstring.uncompressBits({compressed})
    });

    // find resolution list for `requester`
    const encodedRequester = base64url.encode(requester);
    let requesterList = resolution[encodedRequester];

    // see if token is already resolved
    if(resolvedList.get(index)) {
      // token already resolved, see if requester matches
      if(requesterList) {
        const bs = new Bitstring({
          buffer: await Bitstring.uncompressBits({compressed: requesterList})
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
    if(requesterList) {
      bs = new Bitstring({
        buffer: await Bitstring.uncompressBits({compressed: requesterList})
      });
    } else {
      bs = new Bitstring({length: 256});
    }
    bs.set(index, true);
    requesterList = Buffer.from(await bs.compressBits());

    // mark token as resolved
    resolvedList.set(index, true);

    // update token batch
    const query = {
      'tokenBatch.id': batchId,
      // ensure that no change is applied if another process resolved a
      // token concurrently
      'tokenBatch.resolvedList': compressed
    };
    const collection = database.collections['tokenization-tokenBatch'];
    const result = await collection.updateOne(query, {
      $set: {
        'meta.updated': Date.now(),
        'tokenBatch.resolvedList': Buffer.from(
          await resolvedList.compressBits()),
        [`tokenBatch.resolution.${encodedRequester}`]: requesterList
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

/**
 * Sets the `minAssuranceForResolution` on the token batches associated
 * `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {string} options.internalId - The internal ID of the token batch.
 * @param {number} options.minAssuranceForResolution - Minimum level of
 *   assurance required for token resolution.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function setMinAssuranceForResolution({
  internalId, minAssuranceForResolution
}) {
  const query = {
    'tokenBatch.internalId': internalId,
    'tokenBatch.remainingTokenCount': {$gt: 0}
  };
  const $set = {
    'meta.updated': Date.now(),
    'tokenBatch.minAssuranceForResolution': minAssuranceForResolution
  };
  const collection = database.collections['tokenization-tokenBatch'];
  const result = await collection.updateMany(
    query, {$set}, database.writeOptions);

  // return `true` if the update occurred (existing document found)
  return result.result.n !== 0;
}

/**
 * Invalidates the token batch by marking it as invalid, but leaves
 * the record intact so previously resolved tokens are trackable. The
 * remaining token count is set to 0 so no new tokens can be issued from the
 * batch.
 *
 * @param {object} options - Options to use.
 * @param {string} options.internalId - The internal ID of the token batch(es).
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function invalidateTokenBatch({internalId}) {
  const query = {
    'tokenBatch.internalId': internalId
  };
  const $set = {
    'meta.updated': Date.now(),
    'tokenBatch.invalid': true,
    'tokenBatch.remainingTokenCount': 0
  };
  const collection = database.collections['tokenization-tokenBatch'];
  const result = await collection.updateMany(
    query, {$set}, database.writeOptions);

  // return `true` if the update occurred (existing document found)
  return result.result.n !== 0;
}

async function _createToken({
  hmac, batchVersion, tokenBatch, index, attributes
} = {}) {
  const batchId = tokenBatch.id;

  // get version options
  const {id: version, options: {batchIdSize, batchSaltSize}} = batchVersion;

  // build data to encrypt/wrap: batchId|index|aad|padding
  // minimum total = 192-bits, 24 bytes, but can be larger, must be
  // 24 + (n*8) bytes, where n >= 0
  // "aad" is additional authenticated data which is aka "attributes"
  // Note: minimum size is 24 bytes, max is unlimited; size depends on the
  // size of the attributes
  const unwrappedSize = _roundToMultipleOf8(
    batchIdSize + 1 + attributes.length);
  const toWrap = new Uint8Array(unwrappedSize);
  let offset = 0;
  // batch ID, `batchIdSize`, default is 16 bytes
  toWrap.set(batchId, offset);
  // index, 1 byte
  toWrap[offset += batchId.length] = index;
  // attributes (unlimited size, but affects token size, largest it can be
  // without growing the token is 7 bytes, every multiple of 8 thereafter
  // increases the token size by 8), attributes also travel in the
  // clear in the token and their size within the wrapped data must match
  toWrap.set(attributes, offset += 1);
  // random padding for remaining bytes
  offset += attributes.length;
  const padding = await randomBytesAsync(toWrap.length - offset);
  toWrap.set(padding, offset);

  // generate salt based on token version options
  const salt = await randomBytesAsync(batchSaltSize);

  // create KEK via HMAC(batchVersion|salt)
  const kek = await _getKek({hmac, version, salt});

  // wrap `toWrap` as if it were a key, output is 8 more bytes than input
  // per AES-KW spec
  const wrapped = await kek.wrapKey({unwrappedKey: toWrap});

  // build "ConcealedIdToken" payload: batchVersion|salt|wrapped
  // example `tokenSize`:
  // 2 bytes: batchVersion
  // 16 bytes: salt (larger reduces key collisions, but increases token size)
  // 32 bytes: wrapped data (minimum, can be larger by multiples of 8)
  const payloadSize = 2 + salt.length + wrapped.length;
  const payload = new Uint8Array(payloadSize);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  offset = 0;
  // batchVersion, 2 byte uint16
  dv.setUint16(offset, version);
  // salt
  payload.set(salt, offset += 2);
  // wrapped
  payload.set(wrapped, offset += salt.length);

  // ConcealedIdToken "meta" is "attributes"

  // total token size
  // = 50 bytes minimum with attributes up to 7 bytes in size, then additional
  //   multiples of 8 bytes for every multiple of 8 in attributes size
  const jsonldDocument = {
    '@context': CIT_CONTEXT_URL,
    type: 'ConcealedIdToken',
    meta: `z${base58.encode(attributes)}`,
    payload: `z${base58.encode(payload)}`,
  };
  const token = await cborldEncode({
    appContextMap,
    jsonldDocument,
    documentLoader
  });
  return token;
}

async function _parseToken({token}) {
  // validate token
  if(!(token instanceof Uint8Array && token.length >= VERSION_SIZE)) {
    throw new TypeError(
      `"token" must be a Uint8Array that is ${VERSION_SIZE} bytes ` +
      'or more in size.');
  }

  // parse token via cborld
  // token is CBOR-LD encoded "ConcealedIdToken" with a
  // "payload" and optional "meta"
  const parsed = {};
  try {
    const {type, payload, meta} = await cborldDecode({
      appContextMap,
      cborldBytes: token,
      documentLoader
    });
    if(type !== 'ConcealedIdToken') {
      throw new Error(`Invalid token type "${type}".`);
    }

    // decode payload and meta
    if(!(payload && typeof payload === 'string' && payload[0] === 'z')) {
      throw new Error(`Invalid token payload "${payload}".`);
    }
    parsed.payload = base58.decode(payload.substr(1));

    if(meta) {
      if(!(typeof meta === 'string' && meta[0] === 'z')) {
        throw new Error(`Invalid token meta "${meta}".`);
      }
      parsed.attributes = base58.decode(meta.substr(1));
    } else {
      parsed.attributes = new Uint8Array();
    }
  } catch(e) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, e);
  }

  // parse batch version from token payload
  const {payload, attributes} = parsed;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const version = dv.getUint16(0);

  // get token version by `version` ID
  const {batchVersion} = await batchVersions.get({id: version});
  const {options: {batchIdSize, batchSaltSize}} = batchVersion;

  // validate payload size is correct given the batch version
  // payload will contain: batchVersion|salt|wrapped
  // batchVersion = 2 bytes
  // salt = batchSaltSize bytes
  // wrapped = _roundToMultipleOf8(batchIdSize + 1(batchIndex) +
  //   attributes.length) + 8
  // Note: `batchVersion` and `salt` map to crypto used to generate a key and
  // will therefore be authenticated via key unwrapping. The `attributes` can
  // be compared against the unwrapped attributes to be integrity checked
  const wrappedSize = _roundToMultipleOf8(
    batchIdSize + 1 + attributes.length) + 8;
  const payloadSize = VERSION_SIZE + batchSaltSize + wrappedSize;
  if(payload.length !== payloadSize) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      });
  }

  // parse `salt` and `wrapped` from `payload`
  let offset = payload.byteOffset + VERSION_SIZE;
  const salt = new Uint8Array(payload.buffer, offset, batchSaltSize);
  const wrapped = new Uint8Array(
    payload.buffer, offset += batchSaltSize, wrappedSize);

  // get tokenizer associated with version
  const tokenizer = await tokenizers.get({id: batchVersion.tokenizerId});
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

  // at this point, unwrapped is authenticated
  // next, determine if full token is valid

  // parse unwrapped: batchId|index|aad|padding
  offset = unwrapped.byteOffset;
  const batchId = Buffer.from(unwrapped.buffer, offset, batchIdSize);
  const index = unwrapped[batchIdSize];
  // time-safe compare `aad` against given attributes
  const toCompare = new Uint8Array(
    unwrapped.buffer, offset + batchIdSize + 1, attributes.length);
  if(!timingSafeEqual(toCompare, attributes)) {
    // cleartext attributes are not authenticated
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      });
  }

  // token authenticated
  return {batchVersion, tokenizer, batchId, index, attributes};
}

async function _getKek({hmac, version, salt}) {
  // create KEK via HMAC(version|salt)
  const data = new Uint8Array(VERSION_SIZE + salt.length);
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  dv.setUint16(0, version);
  data.set(salt, VERSION_SIZE);
  // use hash signature as `key` for wrapping `toWrap`
  const keyData = base64url.decode(await hmac.sign({data}));
  return createKek({keyData});
}

async function _createBatch({
  internalId, batchVersion, tokenCount = 0, minAssuranceForResolution
}) {
  const {options: {batchIdSize, batchTokenCount}} = batchVersion;

  // _randomBytesAsync is not declared higher up at the module level to support
  // stubbing `crypto.randomBytes` in the test suite
  const _randomBytesAsync = promisify(crypto.randomBytes);

  // generate random batch ID
  const id = await _randomBytesAsync(batchIdSize);

  // if all of the tokens are being claimed, do not create an open token batch
  // record
  const remainingTokenCount = Math.max(0, batchTokenCount - tokenCount);
  if(remainingTokenCount === 0) {
    return _insertBatch({
      id, internalId, batchVersion, tokenCount, minAssuranceForResolution
    });
  }

  /* Note: Since the entire token batch will not be consumed upon creation, we
  must insert an open token batch record in addition to the token batch record
  itself. It is safe to run these two inserts in parallel and the latency
  reduction is more valuable than the rare degenerate cases. The possible
  outcomes from these parallel writes are that another token creation process
  will either see:

  1. No open token batch record. In this case a new token batch record will be
    created to handle the requested tokens. This is not ideal, but not an
    error. The open token batch record will then either be subsequently added
    so that future processes will be able to use it or it will fail to be added
    and the token batch will never be filled. It will eventually expire and be
    removed from the database.
  2. An open token batch record is seen, but no matching token batch record is
    seen. It will be assumed that the token batch record has expired (since it
    is not seen) and the open token batch record will be removed. Then the
    token batch will not ever be filled but it will eventually expire and be
    removed from the database. Again, not ideal, but not an error.
  3. An open token batch record is seen and a token batch record is seen. This
    is the ideal case and constitutes a consistent view of the database.

  Both of the non-ideal cases can only occur when two or more processes for
  creating tokens for a particular user execute concurrently. This is not a
  typical use case for this module. Furthermore, even under those
  circumstances, the non-ideal cases may still not occur. */
  const [record] = await Promise.all([
    _insertBatch({
      id, internalId, batchVersion, tokenCount, minAssuranceForResolution
    }),
    _createOpenBatchReference({internalId, batchId: id})
  ]);
  return record;
}

async function _getOpenBatch({
  internalId, batchVersion, tokenCount, minAssuranceForResolution
}) {
  while(true) {
    let record = await _getUnfilledBatch({internalId, batchVersion});
    if(!record) {
      // no unfilled batch, so create a new batch and claim tokens in it
      record = await _createBatch({
        internalId, batchVersion, tokenCount, minAssuranceForResolution
      });
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

async function _getUnfilledBatch({internalId, batchVersion}) {
  /* Note: Use the `openTokenBatch` collection to find a reference to an
  unfilled batch first. This indirection ensures fast look ups, as we need to
  query without `tokenBatch.id` to find an open batch, which means we must
  shard the references using `internalId` ... and we can't shard the batches
  themselves using `internalId` because hot path queries there will instead
  only have `tokenBatch.id`, not `internalId`. Queries that don't include
  the shard key will be very inefficient so we avoid this by using two separate
  collections that shard differently but ensure the shard key will be present
  in the hot path queries. See the note where the indexes are created above for
  more details. */

  // optimize for the common case where the `batchVersion.id` will match;
  // but handle the case where the batch version has changed and we need to
  // remove references to batches that should no longer be filled because of
  // the new version
  const collection = database.collections['tokenization-tokenBatch'];
  while(true) {
    // should be a fast query on `openTokenBatch` collection using `internalId`
    // shard key
    const referenceRecord = await _getOpenBatchReference({internalId});
    if(!referenceRecord) {
      // no open batches
      return null;
    }

    // get batch via `batchId` in reference (should be a fast query on
    // `tokenBatch` collection using `tokenBatch.id` shard key)
    const {batchId} = referenceRecord;
    const query = {'tokenBatch.id': batchId};
    const projection = {_id: 0};
    const record = await collection.findOne(query, {projection});
    if(!record ||
      record.tokenBatch.batchVersion !== batchVersion.id ||
      record.tokenBatch.remainingTokenCount === 0) {
      // either:
      // no matching record (it must have expired),
      // matching record but version is old (do not continue to fill it),
      // or no tokens left to issue in the batch... in all cases, remove the
      // open batch reference and try again
      await _removeOpenBatchReference({internalId, batchId});
      continue;
    }

    // found an acceptable batch, return it
    return record;
  }
}

async function _insertBatch({
  id, internalId, batchVersion, tokenCount, minAssuranceForResolution
}) {
  // create bitstring to store whether individual tokens have been
  // revolved or not
  const resolvedList = BATCH_INDEX_SIZE_1;

  // auto-claim tokens in batch
  const {options: {batchTokenCount, ttl}} = batchVersion;
  const remainingTokenCount = Math.max(0, batchTokenCount - tokenCount);

  // determine expiration date for batch
  const now = Date.now();
  const expires = new Date(now + ttl);

  const collection = database.collections['tokenization-tokenBatch'];
  const meta = {created: now, updated: now};
  let record = {
    meta,
    tokenBatch: {
      id,
      internalId,
      batchVersion: batchVersion.id,
      resolvedList,
      maxTokenCount: batchTokenCount,
      remainingTokenCount,
      expires,
      minAssuranceForResolution
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

async function _getBatch({id}) {
  const query = {
    'tokenBatch.id': id,
    'tokenBatch.invalid': {$exists: false}
  };
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
  const {internalId, id: batchId} = tokenBatch;
  const target = Math.min(tokenBatch.remainingTokenCount, tokenCount);
  const query = {
    'tokenBatch.internalId': internalId,
    'tokenBatch.id': batchId,
    // we must include the existing `remainingTokenCount` as a monotonically
    // decreasing counter to ensure that the record hasn't changed since
    // we read it (attempts can be made to concurrently issue tokens from
    // the same batch and we must protect against that); this is essentially
    // a proxy for a "version" of the record without needing the additional
    // storage space for a "version" or "sequence" number
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
  // tokens claimed, delete open batch reference if none remain
  if(newRemainingTokenCount === 0) {
    await _removeOpenBatchReference({internalId, batchId});
  }

  // return updated batch info
  const batch = {...tokenBatch, remainingTokenCount: newRemainingTokenCount};
  const startIndex = tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
  return {tokenBatch: batch, startIndex, claimedTokenCount: target};
}

async function _createOpenBatchReference({internalId, batchId}) {
  const now = Date.now();
  const collection = database.collections['tokenization-openTokenBatch'];
  const meta = {created: now, updated: now};
  let record = {
    meta,
    internalId,
    batchId
  };
  try {
    const result = await collection.insertOne(record, database.writeOptions);
    record = result.ops[0];
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate open token batch.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

async function _getOpenBatchReference({internalId}) {
  const query = {internalId};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-openTokenBatch'];
  return collection.findOne(query, {projection});
}

async function _removeOpenBatchReference({internalId, batchId}) {
  const collection = database.collections['tokenization-openTokenBatch'];
  await collection.deleteOne({internalId, batchId}, database.writeOptions);
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
  const value = Buffer.from(await idGenerator.generate());

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

function _roundToMultipleOf8(x) {
  return Math.ceil(x / 8) * 8;
}
