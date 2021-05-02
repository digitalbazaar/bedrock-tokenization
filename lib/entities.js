/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
import assert from 'assert-plus';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';

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
 * Upserts a new entity. If the entity already exists, its current open token
 * batch ID, time to live, and `minAssuranceForResolution` (if passed) will be
 * updated.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {Buffer} [options.batchId=null] - The open token batch ID for the
 *   entity; can be `null` if there is no known open token batch.
 * @param {number} options.ttl - The number of milliseconds until the
 *   entity should expire.
 * @param {number} [options.minAssuranceForResolution] - Minimum level of
 *   identity assurance required for token resolution.
 *
 * @returns {Promise<object>} An object representing the entity record.
 */
export async function upsert({
  // FIXME: should `batchId` and `minAssuranceForResolution` not be included?
  internalId, batchId = null, ttl, minAssuranceForResolution
} = {}) {
  assert.buffer(internalId, 'internalId');
  assert.string(batchId, 'batchId');
  assert.number(ttl, 'ttl');
  assert.optionalNumber(minAssuranceForResolution, 'minAssuranceForResolution');

  const now = Date.now();
  const collection = database.collections['tokenization-entity'];
  const meta = {created: now, updated: now};
  const expires = new Date(now + ttl);
  const entity = {
    internalId,
    batchId,
    // default `minAssuranceForResolution=2`
    minAssuranceForResolution:
      minAssuranceForResolution === undefined ? 2 : minAssuranceForResolution,
    expires
  };
  const query = {'entity.internalId': entity.internalId};
  // set all entity fields except `internalId` on update
  const $set = {
    // FIXME: remove `entity.batchId`
    //'entity.batchId': entity.batchId,
    'entity.expires': entity.expires,
    'meta.updated': meta.updated
  };
  if(minAssuranceForResolution !== undefined) {
    $set['entity.minAssuranceForResolution'] = entity.minAssuranceForResolution;
  }
  // include `internalId` on update
  const $setOnInsert = {
    'entity.internalId': entity.internalId,
    'meta.created': meta.created
  };
  const record = {entity, meta};
  const upsertOptions = {...database.writeOptions, upsert: true};
  // this upsert cannot trigger duplicate error; no try/catch needed
  await collection.updateOne(query, {$set, $setOnInsert}, upsertOptions);
  return record;
}

/**
 * Gets an entity record identified by `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 *
 * @returns {Promise<object>} The entity record.
 */
export async function get({internalId} = {}) {
  const query = {internalId};
  const projection = {_id: 0};
  const collection = database.collections['tokenization-entity'];
  return collection.findOne(query, {projection});
}

/**
 * Removes an entity record identified by `internalId`.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 *
 * @returns {Promise<object>} The entity record.
 */
export async function remove({internalId} = {}) {
  const collection = database.collections['tokenization-entity'];
  await collection.deleteOne({internalId}, database.writeOptions);
}

/**
 * Sets the `batchId` associated with an open token batch for the entity
 * identified by `internalId`. The open token batch can be either pinned
 * or unpinned. A pinned token batch is one where the minimum identity
 * assurance for that batch does not change. An unpinned token batch is
 * the opposite: the minimum identity assurance for the batch can be
 * changed -- these token batches inherit the `minAssuranceForResolution` that
 * is set on the entity itself.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.internalId - The internal ID for the entity.
 * @param {Buffer} options.batchId - The open token batch ID for the entity.
 * @param {number} [options.minAssuranceForResolution] - Minimum level of
 *   identity assurance required for token resolution for the given batch; only
 *   pass this for batches that are locked to a particular assurance.
 * @param {Buffer} [options.oldBatchId] - The old open token batch ID for the
 *   entity; pass this to only update the open batch ID if there is a match.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
export async function setOpenTokenBatchId({
  internalId, batchId, oldBatchId, minAssuranceForResolution
} = {}) {
  const query = {
    'entity.internalId': internalId
  };
  if(oldBatchId !== undefined) {
    if(minAssuranceForResolution !== undefined) {
      query[`entity.pinnedBatch.${minAssuranceForResolution}`] = oldBatchId;
    } else {
      query['entity.unpinnedBatch'] = oldBatchId;
    }
  }
  const $set = {
    'meta.updated': Date.now()
  };
  if(minAssuranceForResolution !== undefined) {
    $set[`entity.pinnedBatch.${minAssuranceForResolution}`] = batchId;
  } else {
    $set['entity.unpinnedBatch'] = batchId;
  }

  const collection = database.collections['tokenization-entity'];
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);

  // return `true` if the update occurred (existing document found)
  return result.result.n !== 0;
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
  const query = {
    'entity.internalId': internalId
  };
  const $set = {
    'meta.updated': Date.now(),
    'entity.minAssuranceForResolution': minAssuranceForResolution
  };

  const collection = database.collections['tokenization-entity'];
  const result = await collection.updateOne(
    query, {$set}, database.writeOptions);

  // return `true` if the update occurred (existing document found)
  return result.result.n !== 0;
}
