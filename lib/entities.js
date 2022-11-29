/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import assert from 'assert-plus';

const {util: {BedrockError}} = bedrock;

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['tokenization-entity']);

  await database.createIndexes([{
    // the `entity` collection must support look ups on `internalId` and its
    // value uniquely identifies an entity, so its shard key is `internalId`
    collection: 'tokenization-entity',
    fields: {'entity.internalId': 1},
    options: {unique: true, background: false}
  }, {
    // automatically expire entities using `expires` date field
    collection: 'tokenization-entity',
    fields: {'entity.expires': 1},
    options: {
      unique: false,
      background: false,
      expireAfterSeconds: 0
    }
  }]);
});

/**
 * Gets an entity record identified by `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with the entity record
 *  or an ExplainObject if `explain=true`.
 */
export async function get({internalId, explain = false} = {}) {
  assert.buffer(internalId, 'internalId');
  const collection = database.collections['tokenization-entity'];
  const query = {'entity.internalId': internalId};
  const projection = {_id: 0};

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
    if(now > record.entity.expires) {
      record = null;
    }
  }
  if(!record) {
    throw new BedrockError(
      'Entity not found.',
      'NotFoundError', {
        httpStatusCode: 404,
        public: true
      });
  }
  return record;
}

/**
 * Sets the `minAssuranceForResolution` for the entity identified by
 * `internalId`. This value affects whether or not a token that was issued
 * from an unpinned token batch will resolve; it does not affect the resolution
 * of tokens that were issued from pinned token batches.
 *
 * @param {object} options - Options to use.
 * @param {string} options.internalId - The internal ID for the entity.
 * @param {number} options.minAssuranceForResolution - Minimum level of
 *   identity assurance required for resolution of tokens that were issued
 *   from an unpinned token batch.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<boolean | ExplainObject>} Resolves with true if update
 *   occurred or an ExplainObject if `explain=true`.
 */
export async function setMinAssuranceForResolution({
  internalId, minAssuranceForResolution, explain = false
} = {}) {
  const query = {'entity.internalId': internalId};
  const $set = {
    'meta.updated': Date.now(),
    'entity.minAssuranceForResolution': minAssuranceForResolution
  };

  const collection = database.collections['tokenization-entity'];

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.updateOne(query, {$set});

  // return `true` if the update occurred
  return result.result.n !== 0;
}

/**
 * Increments an entity's `batchInvalidationCount` to indicate that all
 * unpinned batches are about to be invalidated -- and any that are
 * concurrently created should be considered invalid. The update will only
 * be applied if the entity exists and its `batchInvalidationCount` has not
 * changed from the given value. This is to ensure that any decision made to
 * invalidate token batches based on a previously read value will be consistent
 * with the current state.
 *
 * @param {object} options - Options to use.
 * @param {object} options.entity - The entity.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<boolean | ExplainObject>} Resolves with true if update
 *   occurred or an ExplainObject if `explain=true`.
 */
export async function _incrementBatchInvalidationCount({
  entity, explain = false
} = {}) {
  const {internalId, batchInvalidationCount} = entity;
  const query = {
    'entity.internalId': internalId,
    'entity.batchInvalidationCount': batchInvalidationCount
  };
  const $set = {'meta.updated': Date.now()};
  const $inc = {'entity.batchInvalidationCount': 1};
  const collection = database.collections['tokenization-entity'];

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.updateOne(query, {$set, $inc});

  // return `true` if the update occurred
  return result.result.n !== 0;
}

/**
 * Removes an entity record identified by `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with the entity record
 *   or an ExplainObject if `explain=true`.
 */
export async function _remove({internalId, explain = false} = {}) {
  const collection = database.collections['tokenization-entity'];
  const query = {'entity.internalId': internalId};

  if(explain) {
    // 'find().limit(1)' is used here because 'deleteOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  await collection.deleteOne(query);
}

/**
 * Sets the `batchId` associated with an open token batch with the given
 * `minAssuranceForResolution` for the entity identified by `internalId` and
 * updates the entity record's `expires` date if given and if it is beyond the
 * current `expires` for the entity record.
 *
 * The open token batch can be either pinned or unpinned. A pinned token batch
 * is one where the minimum identity assurance for that batch does not change.
 * An unpinned token batch is the opposite: the minimum identity assurance for
 * the batch can be changed -- these token batches inherit the
 * `minAssuranceForResolution` that is set on the entity itself. Setting
 * `minAssuranceForResolution` to `-1` or using its default value will cause
 * the batch ID to be associated with an unpinned token batch.
 *
 * For unpinned token batches, the update will not apply unless the passed
 * expected `batchInvalidationCount` matches. This value is used to invalidate
 * unpinned token batches; if it does not match, then the token batch is
 * presumed to have been invalidated concurrently and it should not be treated
 * as an open batch.
 *
 * An `expires` date can be optionally passed to update the entity record to
 * expire on the given date (if it is not before the entity record's current
 * `expires` value); this is used to ensure it expires no sooner than
 * its open token batches.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {Buffer} options.batchId - The open token batch ID for the entity.
 * @param {number} options.batchInvalidationCount - The entity's expected
 *   `batchInvalidationCount`; if it does not match the update will not occur.
 * @param {number} [options.minAssuranceForResolution=-1] - Minimum level of
 *   identity assurance required for token resolution for the given batch; for
 *   an unpinned batch omit this value or set it to `-1`.
 * @param {Buffer} [options.oldBatchId] - The old open token batch ID for the
 *   entity; pass this to only update the open batch ID if there is a match.
 * @param {Date} [options.expires] - A new expiration date to apply to the
 *   entity record if it is after the record's current `expires` value.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<boolean | ExplainObject>} Resolves with true if update
 *   occurred or an ExplainObject if `explain=true`.
 */
export async function _setOpenTokenBatchId({
  internalId, batchId, batchInvalidationCount,
  minAssuranceForResolution = -1, oldBatchId, expires, explain = false
} = {}) {
  const query = {'entity.internalId': internalId};
  if(minAssuranceForResolution === -1) {
    query['entity.batchInvalidationCount'] = batchInvalidationCount;
  }
  if(oldBatchId !== undefined) {
    query[`entity.openBatch.${minAssuranceForResolution}`] = oldBatchId;
  }
  const $set = {
    'meta.updated': Date.now(),
    [`entity.openBatch.${minAssuranceForResolution}`]: batchId
  };
  const update = {$set};

  // update entity expiration date to new max
  if(expires !== undefined) {
    // FIXME: enable this
    //update.$max = {'entity.expires': expires};
    console.log('updating entity expires to', expires);
  }

  const collection = database.collections['tokenization-entity'];

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  // return `true` if the update occurred
  const result = await collection.updateOne(query, update);
  return result.result.n !== 0;
}

/**
 * Upserts a new entity. If the entity already exists, its time to live will be
 * updated if it is later than the existing value, but its
 * `minAssuranceForResolution` will not be changed. To change the entity's
 * `minAssuranceForResolution`, call `setMinAssuranceForResolution`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {number} options.ttl - The number of milliseconds until the
 *   entity should expire; this should be synchronized as much as possible
 *   with the entity's open token batches ensuring that when tokens expire,
 *   the entity record also expires.
 * @param {Buffer} [options.externalIdHash] - Optionally previously hashed
 *   (tokenized) externalId, to bind entity to document registrations and
 *   enable fast look ups and refreshes without needing an `internalId` index.
 * @param {number} [options.minAssuranceForResolution] - Minimum level of
 *   identity assurance required for token resolution. This will default to
 *   `2` for new entities.
 * @param {boolean} [options.explain] - An optional explain boolean.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with an object
 *   representing the entity record or an ExplainObject if `explain=true`.
 */
export async function _upsert({
  internalId, ttl, externalIdHash, minAssuranceForResolution,
  explain = false
} = {}) {
  assert.buffer(internalId, 'internalId');
  assert.number(ttl, 'ttl');
  assert.optionalBuffer(externalIdHash, 'externalIdHash');
  assert.optionalNumber(minAssuranceForResolution, 'minAssuranceForResolution');

  const now = Date.now();
  const collection = database.collections['tokenization-entity'];
  const meta = {created: now, updated: now};
  const expires = new Date(now + ttl);
  const entity = {
    internalId,
    batchInvalidationCount: 0,
    openBatch: {},
    // default `minAssuranceForResolution=2`
    minAssuranceForResolution:
      minAssuranceForResolution === undefined ? 2 : minAssuranceForResolution,
    expires
  };
  const query = {'entity.internalId': entity.internalId};
  // only update `expires` on update and only if it extends the record TTL
  const $max = {
    'entity.expires': entity.expires,
  };
  const $set = {
    'meta.updated': meta.updated
  };
  // include all other entity properties on insert
  const $setOnInsert = {
    'entity.internalId': entity.internalId,
    'entity.batchInvalidationCount': entity.batchInvalidationCount,
    'entity.openBatch': {},
    'entity.minAssuranceForResolution': entity.minAssuranceForResolution,
    'meta.created': meta.created
  };
  const update = {$max, $set, $setOnInsert};
  // include `externalIdHash` to enable registered document records
  // note: if tokenizer rotation is used in the future, this value must be
  // updated to match the latest `externalIdHash` if entity records and
  // registered documents are to remain linked post-rotation
  if(externalIdHash) {
    // FIXME: enable
    /*entity.externalIdHash = externalIdHash;
    $setOnInsert['entity.externalIdHash'] = externalIdHash;*/
  }
  const record = {entity, meta};
  const upsertOptions = {...database.writeOptions, upsert: true};

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  // this upsert cannot trigger duplicate error; no try/catch needed
  const result = await collection.updateOne(query, update, upsertOptions);
  if(result.result.upserted) {
    // return full record when upserted
    return {_id: result.result.upserted[0]._id, ...record};
  }
  // return true/false on update
  return result.result.n !== 0;
}

/**
 * An object containing information on the query plan.
 *
 * @typedef {object} ExplainObject
 */
