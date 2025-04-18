/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as batchVersions from '../batchVersions.js';
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import * as documents from '../documents.js';
import * as entities from '../entities.js';
import {create as _createToken} from './format.js';
import assert from 'assert-plus';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import {promisify} from 'node:util';
import {tokenizers} from '@bedrock/tokenizer';

const {util: {BedrockError}} = bedrock;

/* Note: This represents a zero-filled, compressed bitstring of length 256,
used to track the resolution status of tokens in batches with a max size of
256. The configured token batch size for the default token batch version is
only 100, so it fits within this parameter. The config for this module has
comments that indicate that the max configurable token batch size is 256 and
this is because of this implementation detail. */
const EMPTY_RESOLVED_LIST_FOR_MAX_BATCH_SIZE_256 = Buffer.from(
  base64url.decode('H4sIAAAAAAAAA2NgwA8ArVUKGSAAAAA'));

const INTERNAL_ID_SIZE = 16;
const MAX_TOKEN_COUNT = 100;
const MIN_TOKEN_COUNT = 0;

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['tokenization-tokenBatch']);

  const indexes = [{
    /* Note: The `tokenBatch` collection should be sharded by `tokenBatch.id`.
    This collection stores the batch information and is separate from the
    `entity` collection that tracks, per entity, which batch is unfilled
    (more tokens can still be issued from the batch) and what the minimum
    identity assurance for token resolution is. These collections are
    independent because they require different sharding characteristics to
    support different queries and because there needs to be a single place
    where constraints such as required identity assurance is tracked. The
    `tokenBatch` query must support look ups on *only* the `tokenBatch.id` so
    this must be its shard key. */
    collection: 'tokenization-tokenBatch',
    fields: {'tokenBatch.id': 1},
    options: {unique: true}
  }];

  // only create TTL expiration records if configured to do so
  const {autoRemoveExpiredRecords} = bedrock.config.tokenization;
  if(autoRemoveExpiredRecords) {
    indexes.push({
      // automatically expire token batches using `expires` date field
      collection: 'tokenization-tokenBatch',
      fields: {'tokenBatch.expires': 1},
      options: {
        unique: false,
        // grace period of 24 hours; see `documents.js` for grace period note
        expireAfterSeconds: 60 * 60 * 24
      }
    });
  }

  await database.createIndexes(indexes);
});

// creates tokens in a new or existing token batch...
// `tokenizer`, `batchVersion`, `registerPromise`, and `newRegistration` are
// only present when a document registration happens concurrently with the
// creation of tokens
export async function createTokens({
  internalId, attributes = new Uint8Array(), tokenCount,
  minAssuranceForResolution = 2,
  tokenizer, batchVersion,
  registerPromise, newRegistration
} = {}) {
  assert.buffer(internalId, 'internalId');
  assert.number(tokenCount, 'tokenCount');
  assert.number(minAssuranceForResolution, 'minAssuranceForResolution');

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

  if(!tokenizer) {
    // get the current tokenizer
    tokenizer = await tokenizers.getCurrent();
  }

  // get tokenizer ID and hmac interface
  const {id: tokenizerId, hmac} = tokenizer;

  if(!batchVersion) {
    // get version associated with tokenizer, creating it as needed
    ({batchVersion} = await batchVersions.ensureBatchVersion({tokenizerId}));
  }

  // create tokens with limited concurrency
  const {tokenCreationConcurrency: concurrency} = bedrock.config.tokenization;
  const limit = pLimit(concurrency);

  // track latest validity period for any of the tokens
  let validUntil;

  // create tokens until `tokenCount` is reached
  const tokens = [];
  while(tokens.length < tokenCount) {
    // 1. Calculate remaining tokens to issue.
    const target = tokenCount - tokens.length;

    // 2. Get an open batch for creating tokens.
    const {tokenBatch, startIndex, claimedTokenCount} = await _getOpenBatch({
      internalId, batchVersion, tokenCount: target, minAssuranceForResolution,
      registerPromise, newRegistration
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

    // update `validUntil`
    validUntil = new Date(tokenBatch.expires);
  }

  return {tokens, validUntil};
}

export async function getBatch({id, explain = false} = {}) {
  const query = {'tokenBatch.id': id};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-tokenBatch'];

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
    if(now > record.tokenBatch.expires) {
      record = null;
    }
  }
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

/**
 * Updates the `minAssuranceForResolution` for an entity if and only if it
 * has no valid unpinned token batches.
 *
 * Note: It is possible for any valid unpinned token batch, B, to be marked as
 * invalid by this method if the latest created unpinned token batch has
 * expired prior to B expiring. This should never happen if the rule expressed
 * in this module's `config` is followed: that no new token batches should be
 * created with shorter TTLs than existing valid token batches. If the rule is
 * not followed, this does not generate a security issue on its own, UX may
 * suffer (a user that had a valid unpinned token could have it become
 * invalidated by some process that could not see that it existed).
 *
 * @param {object} options - Options to use.
 * @param {object} options.entity - The entity to attempt to update.
 * @param {number} options.minAssuranceForResolution - Minimum level of
 *   identity assurance required for resolution of tokens that were issued
 *   from an unpinned token batch.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function updateEntityWithNoValidBatches({
  entity, minAssuranceForResolution
} = {}) {
  // check whether the entity's open unpinned token batch is still valid; if
  // its `null` it can't be (it is only for brand new entities where no
  // unpinned token batches have ever been created)
  if(entity.openBatch['-1'] !== null) {
    try {
      const {tokenBatch} = await getBatch({id: entity.openBatch['-1']});
      if(tokenBatch.batchInvalidationCount >= entity.batchInvalidationCount) {
        // batch is still valid
        return false;
      }
    } catch(e) {
      // if not found, batch is invalid; throw any other types of errors
      if(e.name !== 'NotFoundError') {
        throw e;
      }
    }
  }

  // set entity's `minAssuranceForResolution` and ensure all unpinned token
  // batches are marked invalid; this call will fail to update if a concurrent
  // process adds a new unpinned token batch
  const updated = await entities._incrementBatchInvalidationCount({
    entity, minAssuranceForResolution
  });
  if(!updated) {
    throw new BedrockError(
      'Entity state changed concurrently.',
      'InvalidStateError', {
        public: true,
        httpStatusCode: 409
      });
  }
  return true;
}

/**
 * Marks all unpinned token batches for an entity as invalid, but leaves the
 * batches intact so that previously resolved tokens records are not lost prior
 * to expiration. Once marked invalid, the token batches will not be used to
 * issue new tokens. If another process tries to invalidate token batches or
 * change the entity's `minAssuranceForResolution` concurrently, then an
 * error will be thrown indicating a conflicting invalid state.
 *
 * @param {object} options - Options to use.
 * @param {object} options.entity - The object representing the entity; this
 *   can be fetched from the record returned by `entities.get()`.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function invalidateBatches({entity} = {}) {
  // updating the `batchInvalidationCount` on the entity marks all current
  // unpinned token batches as invalid
  const updated = await entities._incrementBatchInvalidationCount({entity});
  if(!updated) {
    throw new BedrockError(
      'Entity state changed concurrently.',
      'InvalidStateError', {
        public: true,
        httpStatusCode: 409
      });
  }
  return true;
}

export async function updateBatch({
  batchId, compressed, resolvedList, encodedRequester, requesterList,
  explain = false
} = {}) {
  const query = {
    'tokenBatch.id': batchId,
    // ensure that no change is applied if another process resolved a
    // token concurrently
    'tokenBatch.resolvedList': compressed
  };
  const collection = database.collections['tokenization-tokenBatch'];

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  return collection.updateOne(query, {
    $set: {
      'meta.updated': Date.now(),
      'tokenBatch.resolvedList': Buffer.from(
        await resolvedList.compressBits()),
      [`tokenBatch.resolution.${encodedRequester}`]: requesterList
    }
  });
}

// export for testing purposes
export async function _claimTokens({
  tokenBatch, tokenCount, batchInvalidationCount, explain = false
} = {}) {
  const {internalId, id: batchId} = tokenBatch;
  const target = Math.min(tokenBatch.remainingTokenCount, tokenCount);
  const query = {
    'tokenBatch.id': batchId,
    'tokenBatch.internalId': internalId,
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

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.updateOne(query, {$set});
  if(result.modifiedCount === 0) {
    // could not claim tokens
    return {tokenBatch, claimedTokenCount: 0};
  }
  // tokens claimed, clear open batch reference if none remain
  if(newRemainingTokenCount === 0) {
    // this is only an optimization; don't run it when
    // `minAssuranceForResolution=1` to avoid clearing the last created open
    // batch for unpinned tokens -- which is used to determine whether the
    // entity's `minAssuranceForResolution` needs to be reset
    const {minAssuranceForResolution} = tokenBatch;
    if(minAssuranceForResolution !== -1) {
      await entities._setOpenTokenBatchId({
        internalId, batchId: null, oldBatchId: batchId,
        batchInvalidationCount, minAssuranceForResolution
      });
    }
  }

  // return updated batch info
  const batch = {...tokenBatch, remainingTokenCount: newRemainingTokenCount};
  const startIndex = tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
  return {tokenBatch: batch, startIndex, claimedTokenCount: target};
}

async function _createBatch({
  internalId, batchVersion, tokenCount = 0, batchInvalidationCount,
  minAssuranceForResolution, externalIdHash
}) {
  // _randomBytesAsync is not declared higher up at the module level to support
  // stubbing `crypto.randomBytes` in the test suite
  const _randomBytesAsync = promisify(crypto.randomBytes);

  // generate random batch ID
  const {options: {batchIdSize}} = batchVersion;
  const id = await _randomBytesAsync(batchIdSize);

  // determine expiration date for the batch record; this will also be used
  // when updating the entity record to ensure it lasts as long as the token
  // batch record (provided it ends up being a valid token batch; if not, the
  // entity record will not be updated using the `expires` value)
  const expires = _getTokenBatchExpires({batchVersion});

  /* Note: We insert the token batch and also update the entity record's open
  token batch ID and `expires` value concurrently. We do the entity record
  update regardless of whether the token batch is entirely consumed in order to
  ensure that the entity record's `expires` value is always at least as long as
  the valid token batches associated with it. We also ensure that any
  associated document registration records are refreshed (`expires` extended)
  prior to setting the open batch ID -- ensuring that no tokens will be issued
  from an open batch that could expire prior to document registration records.

  It is safe to run these two operations in parallel and the latency reduction
  is more valuable than the rare degenerate cases. The possible outcomes from
  these parallel writes are that another token creation process will either
  see:

  1. An open token batch ID with no matching token batch record. It will be
    assumed that the token batch record has expired (since it is not seen) and
    a different token batch will be created and used. The token batch we create
    here will not ever be filled but it will eventually expire and be removed
    from the database. This is not an efficient use of token batches, but it is
    expected to be rare and is not an error.
  2. An open token batch ID is seen and the token batch record it refers to
    is seen. This is the ideal case and constitutes a consistent view of the
    database.

  The non-ideal case only occurs when two or more processes for creating tokens
  for a particular user execute concurrently. This is not a typical use case
  for this module. Furthermore, even under those circumstances, the ideal case
  may still occur. */
  const [record] = await Promise.all([
    _insertBatch({
      id, internalId, batchVersion, tokenCount, minAssuranceForResolution,
      expires, batchInvalidationCount
    }),
    _refreshDocumentRegistrationsThenSetOpenBatchId({
      externalIdHash, expires, internalId, batchId: id, batchInvalidationCount,
      minAssuranceForResolution
    })
  ]);
  return record;
}

async function _getOpenBatch({
  internalId, batchVersion, tokenCount, minAssuranceForResolution,
  registerPromise, newRegistration
}) {
  // loop trying to claim tokens in an unfilled batch... competing against
  // concurrent processes trying to claim tokens in the same unfilled batch
  let entityRecord;
  while(true) {
    const records = await _getUnfilledBatch(
      {internalId, batchVersion, minAssuranceForResolution});
    ({entityRecord} = records);
    const {unfilledRecord} = records;
    if(!unfilledRecord) {
      // no unfilled batch, break to create a new batch for the entity record
      break;
    }
    // try to claim tokens in unfilled batch
    const {tokenBatch} = unfilledRecord;
    const {batchInvalidationCount} = entityRecord.entity;
    const result = await _claimTokens(
      {tokenBatch, tokenCount, batchInvalidationCount});
    if(result.claimedTokenCount > 0) {
      // tokens claimed, return them
      return result;
    }
  }

  // no unfilled batch, so create a new batch and claim tokens in it...

  /* Note: Token batches may have their own `minAssuranceForResolution` or
  they may inherit it from whatever value is presently set on the
  associated entity. A value of `minAssuranceForResolution == -1` means
  that the value is inherited.

  If a token batch has its own `minAssuranceForResolution` (it is not
  passed as `-1` here), then it is a locked value that does not change.
  These types of token batches are referred to as pinned batches for this
  reason. Whenever we create a new pinned batch, we do not need to perform
  any additional checks before issuing tokens from it. This is "Case 0".
  The other cases are below.

  If a token batch inherits `minAssuranceForResolution` from its associated
  entity, then this resolution value changes whenever it is changed on
  on entity. This type of batch is referred to as "unpinned". Since their
  resolution value can change, it must also be possible to invalidate
  unpinned batches to prevent stale batches from being used.

  Consider the use case where tokens are issued to a holder via a system
  that cannot perform sufficient identity assurance. These tokens will be
  issued while the entity's minimum assurance for token resolution is a
  high value, ensuring that they cannot be erroneously resolved. The holder
  could then provide additional assurance to another system that is capable
  of lowering the entity's minimum assurance for token resolution. This
  would enable the previously issued tokens to be resolved with reduced
  assurance as the holder is known, with sufficient assurance, to represent
  the entity.

  In this use case, we must prevent a party that is not the entity from
  holding valid tokens that would similarly inherit the minimum assurance
  for resolution from the entity -- as they would also be able to have
  these tokens resolve despite the fact that they did not provide the
  appropriate identity assurance. Therefore, we must provide an API to
  allow unpinned token batches to be invalidated prior to issuing new ones.

  It is up to the caller to ensure that unpinned token batches are
  invalidated based on their use cases. However, this module is responsible
  for ensuring consistent state with respect to token batch invalidation.

  Therefore, whenever a new unpinned batch record is created, we must
  account for the case where we created the unpinned batch while another
  process was attempting to invalidate existing unpinned batches. That
  other process could fail to see and invalidate the one we just created,
  so we must ensure that we have not hit that case.

  The way we ensure that is by fetching the entity record and checking to
  see if its `batchInvalidationCount` number has changed, indicating that
  the process should be considered more recent than ours, and it has
  invalidated unpinned token batches while we created our batch. We must
  not issue tokens from our batch when this occurs.

  There's another wrinkle to consider when checking for the above change,
  which is that registration and batch creation may be occuring
  concurrently to perform an optimistic optimization. In that case,
  `registerPromise` will be set. When it is set, it is also possible for
  `entityRecord` to be `null`.

  Note: If `entityRecord` is `null` and `registerPromise` is not set, then
  the caller has made an error and failed to register the entity prior to
  calling create. This case is a misuse of the API.

  Here are the remaining cases to consider:

  1. The entity record is `null` because it has expired and will be
  assigned a new `internalId`. We know we are in this case when
  `entityRecord` is `null` and `newRegistration` is `false`.

  2. The entity record is `null` because it is new and we have raced
  ahead in creating its first token batch before it was registered (which
  is happening concurrently).

  3. An existing entity record is present. It could have just been
  registered or it may have already existed previously.

  In case 1, we simply return because it is safe to assume that the caller
  will need to call `create` again with a new `internalId`. The batch
  we created will eventually be garbage collected.

  In case 2, we can safely assume that `batchInvalidationCount` would have
  been initialized to `0`, so we will await `registerPromise` and then
  fetch the entity record to ensure its still `0`.

  In case 3, we use the `batchInvalidationCount` from the existing entity
  record and then we must await `registerPromise` and fetch the entity
  record to ensure it matches the original value.

  Note: Cases 2 and 3 can be handled by the same general code path. */

  // first get original batch invalidation count; default its value to 0
  // to cover cases where the entity record does not exist
  let originalBatchInvalidationCount = 0;
  if(entityRecord) {
    // get original count from entity record
    originalBatchInvalidationCount =
      entityRecord.entity.batchInvalidationCount;
  } else if(!registerPromise) {
    // misuse of the API
    throw new Error(
      'Entities must be registered prior to or concurrently with token ' +
      'creation.');
  }

  /* Note: `_createBatch` always updates the entity record's `expires`
  value and, if an entity record already exists, any associated document
  registration records' `expires` values. This ensures all these records will
  persist at least as long as any new valid token batch. Note that in the
  case that no entity record exists, registration must be occurring
  concurrently as checked above, which means at least one document registration
  record with a sufficiently long `expires` value will be inserted imminently
  so no update to existing records is required. This also allows other
  registered documents for the same `externalIdHash` to expire in the cases
  where a replacement document is known to be getting registered. */

  // create the new batch
  const {tokenBatch} = await _createBatch({
    internalId, batchVersion, tokenCount, minAssuranceForResolution,
    batchInvalidationCount: originalBatchInvalidationCount,
    externalIdHash: entityRecord?.entity.externalIdHash
  });
  const claimedTokenCount =
    tokenBatch.maxTokenCount - tokenBatch.remainingTokenCount;
  const result = {tokenBatch, startIndex: 0, claimedTokenCount};

  // check for case 0 from above (simplest case)
  if(minAssuranceForResolution !== -1) {
    // token batch is pinned to a particular `minAssuranceForResolution`,
    // so we don't need to run additional checks for batch invalidation
    return result;
  }

  // check for case 1 from above (next simplest case)
  if(!entityRecord && !newRegistration) {
    // entity has expired and will be assigned a new `internalId`; return
    // to allow this function to be called again
    return result;
  }

  // handle cases 2 and 3 together...

  // await registration
  await registerPromise;

  // now ensure that `batchInvalidationCount` has not changed
  const entityRecordAfter = await entities.get({internalId});
  const {entity: {batchInvalidationCount}} = entityRecordAfter;
  if(originalBatchInvalidationCount !== batchInvalidationCount) {
    throw new BedrockError(
      'Token batch invalidated.',
      'NotAllowedError', {
        public: true,
        httpStatusCode: 403
      });
  }

  return {tokenBatch, startIndex: 0, claimedTokenCount};
}

async function _getUnfilledBatch({
  internalId, batchVersion, minAssuranceForResolution
}) {
  /* Note: Use the `entity` collection to find a reference to an unfilled
  batch first. This indirection ensures fast look ups, as we need to query
  without `tokenBatch.id` to find an open batch, which means we must shard the
  entities (and their open batch references) using `internalId` ... and we
  can't shard the batches themselves using `internalId` because hot path
  queries there will instead only have `tokenBatch.id`, not `internalId`.
  Queries that don't include the shard key will be very inefficient so we avoid
  this by using two separate collections that shard differently but ensure the
  shard key will be present in the hot path queries. See the notes where the
  indexes are created for more details. */

  // optimize for the common case where the `batchVersion.id` will match;
  // but handle the case where the batch version has changed and we need to
  // remove references to batches that should no longer be filled because of
  // the new version

  // should be a fast query on `entity` collection using `internalId`
  // shard key
  let entityRecord;
  try {
    entityRecord = await entities.get({internalId});
  } catch(e) {
    // ignore not found, entity could be getting registered concurrently
    // or have expired
    if(e.name !== 'NotFoundError') {
      throw e;
    }
  }
  const key = '' + minAssuranceForResolution;
  if(!entityRecord || !entityRecord.entity.openBatch[key]) {
    // entity does not exist, either it is being created concurrently, or it
    // has expired; if entity does exist but batch ID is null/undefined then
    // there is no open batch -- in all cases here, there is no open batch
    return {unfilledRecord: null, entityRecord};
  }

  // get batch via `batchId` in reference (should be a fast query on
  // `tokenBatch` collection using `tokenBatch.id` shard key)
  const {batchInvalidationCount} = entityRecord.entity;
  const batchId = entityRecord.entity.openBatch[key];
  let record;
  try {
    record = await getBatch({id: batchId});
    /* Note: Treat record as not found if it will expire before half of its
    TTL time. This is done to ensure that no individual tokens will be issued
    from the batch with TTLs that are shorter than half of the maximum TTL
    for the entire batch. Also note that it is important that we can determine
    whether an entity has no valid, open unpinned token batches -- allowing
    applications to reset `minAssuranceForResolution` to some value in those
    cases. Whenever a new unpinned token batch is created, if its will expire
    prior to an existing valid token batch, that valid token batch will be
    treated as invalid when this reset call is made. See the comments in this
    module's `config` for more information. */
    if(record) {
      const expiresTime = record.tokenBatch.expires.getTime();
      const ttl = expiresTime - record.meta.created;
      const notAfter = expiresTime - Math.ceil(ttl / 2);
      if(Date.now() > notAfter) {
        record = null;
      }
    }
  } catch(e) {
    if(e.name !== 'NotFoundError') {
      throw e;
    }
  }

  // if either:
  // 1. no matching record (it must have expired or expiring too soon to use),
  // 2. matching record but version is old (do not continue to fill it),
  // 3. no tokens left to issue in the batch, or
  // 4. batch is unpinned and has been invalidated
  // ...in all cases, there is no usable open batch
  if(!record ||
    record.tokenBatch.batchVersion !== batchVersion.id ||
    record.tokenBatch.remainingTokenCount === 0 ||
    // an unpinned batch (`minAssuranceForResolution === -1`) is invalid if
    // its `batchInvalidationCount` is less than the entity's
    (minAssuranceForResolution === -1 &&
    record.tokenBatch.batchInvalidationCount < batchInvalidationCount)) {
    /* Note: It is not possible for an unpinned, open token batch's
    `batchInvalidationCount` to be less than the entity's because the
    values must match when an open token batch ID is set on the entity or
    the update will not occur (and because the value is immutable in the
    token batch record). This ensures that the only possible values for the
    unpinned open token batch that we fetched are less than or equal to
    the entity's. If they are equal, we use the batch, if less we fall
    into this conditional and attempt to clear it. */

    // no usable batch
    record = null;

    // scheduling and update to set open token batch to `null` is only an
    // optimization; don't run it when `minAssuranceForResolution=1` to avoid
    // clearing the last created open batch for unpinned tokens -- which is
    // used to determine whether the entity's `minAssuranceForResolution` needs
    // to be reset
    if(minAssuranceForResolution !== -1) {
      // schedule update to set open token batch to `null` (provided it has not
      // changed concurrently -- we pass `oldBatchId` to enforce this) and
      // return that there is no usable open batch
      entities._setOpenTokenBatchId({
        internalId, batchId: null, oldBatchId: batchId, batchInvalidationCount,
        minAssuranceForResolution
      }).catch(() => {
        // ignore errors here, we do not require an update; another process
        // may concurrently set a different open batch to use which is fine
      });
    }
  }

  return {unfilledRecord: record, entityRecord};
}

async function _insertBatch({
  id, internalId, batchVersion, tokenCount, batchInvalidationCount,
  expires, minAssuranceForResolution = -1
}) {
  // create bitstring to store whether individual tokens have been
  // revolved or not
  const resolvedList = EMPTY_RESOLVED_LIST_FOR_MAX_BATCH_SIZE_256;

  // auto-claim tokens in batch
  const {options: {batchTokenCount}} = batchVersion;
  const remainingTokenCount = Math.max(0, batchTokenCount - tokenCount);

  const collection = database.collections['tokenization-tokenBatch'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  const record = {
    meta,
    tokenBatch: {
      id,
      internalId,
      batchVersion: batchVersion.id,
      resolvedList,
      maxTokenCount: batchTokenCount,
      remainingTokenCount,
      expires,
      batchInvalidationCount,
      minAssuranceForResolution
    }
  };
  try {
    await collection.insertOne(record);
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

function _getTokenBatchExpires({batchVersion}) {
  /* Note: Entity and document registration expiration records should never be
  treated as expunged prior to associated token batches. External factors could
  always cause a token batch record to continue to persist even if these other
  records have expired, so the `expires` field on token batches must be checked
  when fetching batches just in case this happens. */
  const {options: {ttl}} = batchVersion;
  const now = Date.now();
  const expires = new Date(now + ttl);
  return expires;
}

async function _refreshDocumentRegistrationsThenSetOpenBatchId({
  externalIdHash, expires, internalId, batchId, batchInvalidationCount,
  minAssuranceForResolution
}) {
  // before marking the open token batch ID as available for use, ensure
  // that any associated document registration record `expires` are updated
  if(externalIdHash) {
    await documents.refreshAll({externalIdHash, internalId, expires});
  }

  /* Note: The only time this call will not update the entity record is if
  the `batchInvalidationCount` has changed and `minAssuranceForResolution`
  is `-1`. In that case, the inserted batch will be invalidated and not
  used. In all other cases, the batch will be used and the entity record
  will be updated (we don't block updates where the old batch ID does not
  match by not passing it here), ensuring its `expires` field is updated. */
  return entities._setOpenTokenBatchId({
    internalId, batchId, batchInvalidationCount,
    minAssuranceForResolution, expires
  });
}
