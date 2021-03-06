/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import assert from 'assert-plus';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
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
    // automatically expire entities with an `expires` date field
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
 *
 * @returns {Promise<object>} The entity record.
 */
export async function get({internalId} = {}) {
  const collection = database.collections['tokenization-entity'];
  const query = {'entity.internalId': internalId};
  const projection = {_id: 0};
  const record = await collection.findOne(query, {projection});
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
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function setMinAssuranceForResolution({
  internalId, minAssuranceForResolution
} = {}) {
  const query = {'entity.internalId': internalId};
  const $set = {
    'meta.updated': Date.now(),
    'entity.minAssuranceForResolution': minAssuranceForResolution
  };

  const collection = database.collections['tokenization-entity'];
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);

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
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function _incrementBatchInvalidationCount({entity} = {}) {
  const {internalId, batchInvalidationCount} = entity;
  const query = {
    'entity.internalId': internalId,
    'entity.batchInvalidationCount': batchInvalidationCount
  };
  const $set = {'meta.updated': Date.now()};
  const $inc = {'entity.batchInvalidationCount': 1};
  const collection = database.collections['tokenization-entity'];
  const result = await collection.updateOne(
    query, {$set, $inc}, database.writeOptions);

  // return `true` if the update occurred
  return result.result.n !== 0;
}

/**
 * Removes an entity record identified by `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 *
 * @returns {Promise<object>} The entity record.
 */
export async function _remove({internalId} = {}) {
  const collection = database.collections['tokenization-entity'];
  const query = {'entity.internalId': internalId};
  await collection.deleteOne(query, database.writeOptions);
}

/**
 * Sets the `batchId` associated with an open token batch with the given
 * `minAssuranceForResolution` for the entity identified by `internalId`. The
 * open token batch can be either pinned * or unpinned. A pinned token batch is
 * one where the minimum identity assurance for that batch does not change. An
 * unpinned token batch is the opposite: the minimum identity assurance for the
 * batch can be changed -- these token batches inherit the
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
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function _setOpenTokenBatchId({
  internalId, batchId, oldBatchId, batchInvalidationCount,
  minAssuranceForResolution = -1
} = {}) {
  const query = {'entity.internalId': internalId};
  if(minAssuranceForResolution === -1) {
    query['entity.batchInvalidationCount'] = batchInvalidationCount;
  }
  if(oldBatchId !== undefined) {
    query[`entity.openBatch.${minAssuranceForResolution}`] = oldBatchId;
  }
  const $set = {
    'meta.updated': Date.now()
  };
  $set[`entity.openBatch.${minAssuranceForResolution}`] = batchId;

  const collection = database.collections['tokenization-entity'];
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);

  // return `true` if the update occurred
  return result.result.n !== 0;
}

/**
 * Upserts a new entity. If the entity already exists, its time to live will be
 * updated, but its `minAssuranceForResolution` will not be changed. To change
 * the entity's `minAssuranceForResolution`, call
 * `setMinAssuranceForResolution`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {number} options.ttl - The number of milliseconds until the
 *   entity should expire.
 * @param {number} [options.minAssuranceForResolution] - Minimum level of
 *   identity assurance required for token resolution. This will default to
 *   `2` for new entities.
 *
 * @returns {Promise<object>} An object representing the entity record.
 */
export async function _upsert({
  internalId, ttl, minAssuranceForResolution
} = {}) {
  assert.buffer(internalId, 'internalId');
  assert.number(ttl, 'ttl');
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
  // only update ttl on update
  const $set = {
    'entity.expires': entity.expires,
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
  const record = {entity, meta};
  const upsertOptions = {...database.writeOptions, upsert: true};
  // this upsert cannot trigger duplicate error; no try/catch needed
  const result = await collection.updateOne(
    query, {$set, $setOnInsert}, upsertOptions);
  if(result.result.upserted) {
    // return full record when upserted
    return {_id: result.result.upserted[0]._id, ...record};
  }
  // return true/false on update
  return result.result.n !== 0;
}
