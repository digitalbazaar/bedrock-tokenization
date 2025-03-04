/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import * as entities from './entities.js';
import assert from 'assert-plus';
import canonicalize from 'canonicalize';
import {Cipher} from '@digitalbazaar/minimal-cipher';
import {createKeyResolver} from './keyResolver.js';
import {IdGenerator} from 'bnid';
import {tokenizers} from '@bedrock/tokenizer';

const {util: {BedrockError}} = bedrock;

const TEXT_ENCODER = new TextEncoder();

// 128 bit random id generator
const idGenerator = new IdGenerator({bitLength: 128});

/* Note on TTL index grace periods:

Records that match a TTL index are auto-removed from a mongodb collection based
on the index option `expireAfterSeconds`. This option can be interpreted as a
grace period prior to the removal of records. Using a value other than `0`
provides better resiliency for decision making processes that must retrieve
records, make decisions about them (based on their existence) and then update
them to extend their expiration period.

If there is no sufficiently long grace period, then such a process could
retrieve an imminently expiring record, make a decision, and then try to
update the record to extend its expiration period and fail to find it.

Processes could be modified to account for these exceptions, but that
approach is more complex than ensuring that the record persists long enough
for its expiration period to be extended.

The grace period chosen is considered long enough to ensure an expectation
that there will be no processes that experience these exceptions. */
bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections(['tokenization-registration']);

  const indexes = [{
    /* Note: There may be multiple documents that match the same
    `externalIdHash` and queries must be supported to find them all using
    just that value. However, documents should be unique based on
    `documentHash`. Also, there is an expectation that multiple `internalId`
    values will not be used for the same `externalIdHash` (`externalIdHash`
    should always map to just one `internalId`), but it is not enforced by
    index due to sharding complexities. Instead, a real world violation of
    this rule is unexpected to occur; it can only occur if two different
    documents with the same `externalId` are registered concurrently (within
    milliseconds of one another). If this does happen in a system, then two
    different entities will be created for the different documents. The
    present design considers this acceptable risk given the tradeoffs.
    Also note that an index is not created for `registration.internalId`
    because it would not include the shard key (`externalIdHash`) and queries
    based on that field alone are rare, they are not run in hot code paths, and
    they do not need to run quickly. Therefore, the index cost is not
    justified. */
    // `externalIdHash` should be a shard key
    collection: 'tokenization-registration',
    fields: {'registration.externalIdHash': 1, 'registration.documentHash': 1},
    options: {unique: true}
  }, {
    // index for the `getCount` query
    collection: 'tokenization-registration',
    fields: {'registration.creatorHash': 1, 'meta.created': 1},
    options: {unique: false}
  }];

  // only create TTL expiration records if configured to do so
  const {autoRemoveExpiredRecords} = bedrock.config.tokenization;
  if(autoRemoveExpiredRecords) {
    indexes.push({
      // automatically expire registrations using `expires` date field
      collection: 'tokenization-registration',
      fields: {'registration.expires': 1},
      options: {
        unique: false,
        // grace period of 24 hours
        expireAfterSeconds: 60 * 60 * 24
      }
    });
  }

  await database.createIndexes(indexes);
});

/**
 * Extends the expiration period for any registration records that match the
 * given `externalIdHash` that would otherwise expire sooner.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} options.externalIdHash - Previously hashed (tokenized)
 *   externalId.
 * @param {Buffer} [options.internalId] - The optional internal ID to restrict
 *   registration record refreshes to.
 * @param {Date} options.expires - The new expiration date to use.
 * @param {boolean} [options.explain] - Set to true to return database query
 *   explain information instead of executing database queries.
 *
 * @returns {Promise<boolean | ExplainObject>} Resolves with `true` if any
 *   records were updated and `false` if none were -- or an ExplainObject if
 *   `explain=true`.
 */
export async function refreshAll({
  externalIdHash, internalId, expires, explain = false
} = {}) {
  const query = {
    'registration.externalIdHash': externalIdHash,
    // only extend expiration period, do not shorten it
    'registration.expires': {$lt: expires}
  };
  if(internalId) {
    // restrict registration updates to records that match given `internalId`
    query['registration.internalId'] = internalId;
  }
  const now = Date.now();
  const update = {
    $set: {
      'meta.updated': now,
      'registration.expires': expires
    }
  };
  const collection = database.collections['tokenization-registration'];

  if(explain) {
    // 'find().limit(1)' is used here because 'updateMany()' doesn't
    // return a cursor which allows the use of the explain function.
    const projection = {_id: 0};
    const cursor = await collection.find(query, {projection}).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.updateMany(query, update);
  // return whether any updates occurred
  return result.modifiedCount !== 0;
}

/**
 * Retrieves the encrypted registration for an internalId.
 * This function may be extremely slow to execute, so do not call it in any hot
 * code paths.
 *
 * @param {object} options - Options to use.
 * @param {string} options.internalId - The internalId to use.
 * @param {boolean} [options.explain] - Set to true to return database query
 *   explain information instead of executing database queries.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with the registration
 *   database record or an ExplainObject if `explain=true`.
 */
export async function getRegistration({internalId, explain = false} = {}) {
  // this query will be slow due to *intentionally* not having an index on
  // `registration.internalId`; see index creation comments above.
  const query = {
    'registration.internalId': internalId
  };
  const collection = database.collections['tokenization-registration'];

  if(explain) {
    // 'find().limit(1)' is used here because 'findOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  let record = await collection.findOne(query);
  if(record) {
    // explicitly check `expires` against current time to handle cases where
    // the database record just hasn't been expunged yet
    const now = new Date();
    if(now > record.registration.expires) {
      record = null;
    }
  }
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Document not found.',
      'NotFoundError', details);
  }
  return record;
}

/**
 * Registers a `document` associated with an entity that is unambiguously
 * identified via `externalId`. Multiple documents associated with the same
 * entity may be registered by using the same `externalId`; `externalId`
 * must be determined by the application.
 *
 * An `internalId` will be generated to unambiguously refer to the same
 * entity referenced by `externalId`. This `internalId` will be randomly
 * generated to prevent unwanted correlation -- and the `externalId` that
 * is given will be HMAC'd using key material that resides in an external
 * system before storing it is stored. This approach ensures that a stolen
 * database on its own will not reveal the correlation between a particular
 * `externalId` and an `internalId`. This `internalId` will persist and be
 * reused across all documents registered using the same `externalId`.
 *
 * The `document` will be encrypted to the given `recipients` before it is
 * stored. It will also be marked for expiration using the given `ttl`
 * parameter. Once all of the registered documents for a given `externalId`
 * have expired, the `externalId` and its associated `internalId` will be
 * removed such that if the same `externalId` is given in the future, a
 * new `internalId` will be generated. That a new `internalId` will be used
 * for future interactions with the same `externalId` is another reason why
 * the `internalId` is generated randomly as opposed to computed as an HMAC
 * value from the `externalId`.
 *
 * Note: Using an HMAC value for `internalId` would help enforce preventing
 * duplicate entities from being concurrently generated for the same
 * `externalId`, and it would still prevent revealing correlation in the
 * event of a stolen database, but it would not provide the added value of
 * changing the `internalId` each time an entity fully left the system and
 * their previously stored interactions were purged. This added value allows
 * entities to return to the system after expiration without linkage to
 * data associated with the previous `internalId`.
 *
 * Optional `creator` can be provided to identify the party that created the
 * registration. This information will be HMAC'd before being stored in the
 * database and thus cannot be reversed but only verified by parties that
 * have access to the original data and a capability to use the HMAC key.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} [options.internalId] - An optional internal ID to use, if
 *   not provided, one will be generated or reused if there is a matching
 *   document registration; if one is provided, then the returned document
 *   MUST be checked to ensure that the `internalId` matches what was passed
 *   as an existing, matching registration with a different `internalId` may
 *   have been updated instead.
 * @param {string} options.externalId - An application-specific string that
 *   unambiguously identifies a particular entity to the application.
 * @param {object} options.document - The document to register.
 *
 * Note: Either `recipients` or `recipientChain` is required.
 * @param {Array<object>} [options.recipients] - A list of recipients identified
 *   by key agreement key ids. An ephemeral ECDH key will be generated and used
 *   to derive shared KEKs that will wrap a randomly generated CEK. The CEK will
 *   be used to encrypt the document. Each recipient in the `recipients` array
 *   will be capable of decrypting the document.
 * @param {Array<Array<object>>} [options.recipientChain] - Same as `recipients`
 *   param above, but contains _nested arrays_ of key agreement key ids.
 *   Use this if you want to first encrypt with one set of recipients, then
 *   encrypt the resulting JWE with the next array of recipients, and so on.
 *
 * @param {number} options.ttl - The number of milliseconds until the
 *   document should expire.
 * @param {number} [options.minAssuranceForResolution] - Minimum level of
 *   assurance required for token resolution. This will default to `2` for
 *   new entities.
 * @param {string} [options.creator] - Optional identifier for the creator
 *   of the registration.
 * @param {object} [options.tokenizer] - Optional tokenizer to use.
 * @param {Buffer} [options.externalIdHash] - Optionally previously hashed
 *   (tokenized) externalId.
 * @param {Buffer} [options.documentHash] - Optionally previously hashed
 *   (tokenized) document.
 * @param {Buffer} [options.creatorHash] - Optionally previously hashed
 *   (tokenized) creator.
 * @param {boolean} [options.newRegistration] - Optionally specify whether or
 *   not a registration is expected to be new; if this is set to `false`,
 *   and the registration does not exist, then an error will be thrown.
 *
 * @returns {Promise<object>} An object with the registration record.
 */
export async function register({
  internalId, externalId, document, recipients, recipientChain,
  minAssuranceForResolution, ttl, creator, tokenizer, externalIdHash,
  documentHash, creatorHash, newRegistration
} = {}) {
  assert.number(ttl, 'ttl');
  assert.optionalArrayOfObject(recipients, 'recipients');
  assert.optionalArrayOfArray(recipientChain, 'recipientChain');
  if(recipientChain) {
    if(recipients) {
      throw new TypeError(
        'Only one of "recipients" or "recipientChain" is allowed.');
    }
    if(recipientChain.length === 0) {
      throw new TypeError('"recipientChain" must be a non-empty array.');
    }
    recipientChain.forEach(e => assert.arrayOfObject(e));
  } else if(!recipients) {
    throw new TypeError('"recipients" or "recipientChain" is required.');
  }

  // 1. & 2. Get tokenizer and hmac hashed fields if they were not passed in.
  if(!tokenizer) {
    tokenizer = await tokenizers.getCurrent();
  }
  if(!(externalIdHash && documentHash)) {
    ({tokenizer, externalIdHash, documentHash, creatorHash} =
      await _tokenizeRegistration({tokenizer, externalId, document, creator}));
  }

  while(true) {
    // 3. Attempt to refresh the expiration for the document if it is not
    //    known to be a new registration.
    if(newRegistration !== true) {
      // optimistically upsert the entity in parallel here... but the caller
      // will need to check afterwards to ensure that the `internalId` from
      // the record matches the one passed in as the docs state
      let upsertEntityPromise;
      if(internalId) {
        upsertEntityPromise = entities._upsert(
          {internalId, ttl, externalIdHash, minAssuranceForResolution});
      }

      // concurrently attempt to refresh an existing registration and upsert
      // the associated entity (if `internalId` was given)
      const [{updated, record}, upsertEntityResult] = await Promise.all([
        _refresh({externalIdHash, documentHash, ttl, creatorHash}),
        upsertEntityPromise
      ]);
      if(updated) {
        // doc already registered and now refreshed, no need to encrypt; just
        // ensure entity is also refreshed
        if(!upsertEntityResult) {
          /* Note: This code path should be very uncommon if systems are
          checking for an existing registration (and fetching the `internalId`
          prior to calling `register`); in which case `entities._upsert` will
          run in parallel alongside `_refresh` and both should succeed in the
          common case. Taking that approach would yield the lowest-latency
          approach to registration, whereas this would be the slowest. */
          await entities._upsert({
            internalId: record.registration.internalId,
            ttl, externalIdHash, minAssuranceForResolution
          });
        }
        return record;
      }
    }

    // at this point the registration is known to be new/not exist, so
    // throw an error if it was expected to exist
    // FIXME: current implementation could trigger a 404 when the update
    // modifies no document because of an exactly simultaneous concurrent
    // update; this should be handled gracefully externally but could perhaps
    // be improved here by checking for `record` above instead of `updated`
    // (if that logic is appropriate); this might also simplify logic below
    if(newRegistration === false) {
      const details = {
        httpStatusCode: 404,
        public: true
      };
      throw new BedrockError(
        'Document not found.',
        'NotFoundError', details);
    }

    /* Note: At this point, we expect that we need to insert a document
    registration record because either:

    1. A document registration record associated with the external ID and
    document hash doesn't exist,

    2. It does exist in the database but has been marked as expired (and the
    external caller may or may not have set `newRegistration=true` on this
    basis),

    3. The same expiration date *happened* to be set by another concurrent
    process in the above `refresh` call, resulting in this process not seeing
    any records being modified in the above update call.

    We assume the more common case that there is no such document with the
    given `externalIdHash` and `documentHash` and go ahead and generate an
    `internalId` for the document and encrypt it. We try to upsert an entity
    record with that `internalId` and then try to insert the document
    registration record.

    Now, if our assumption is incorrect (and therefore some matching document
    registration record exists), the entity record with the given `internalId`
    that was inserted can be safely ignored and allowed to expire. The document
    registration record will not be inserted due to a duplicate error (which
    also means that the encrypted data won't be used and will be safely
    discarded).

    If this duplicate error occurs, we need to clear any assumption that a
    new registration is being made, clear any `internalId` generated, and loop
    to ensure to ensure that the document registration record (if expired) is
    updated with a new expiration date. */

    // 4. Generate a new random internal ID to associate with `externalId` if
    //    none has been set yet.
    if(!internalId) {
      internalId = await _generateInternalId();
    }

    // 5. Upsert `entity` in parallel and await it after registration
    //    completes. Note: Resolve the promise to an error if it rejects to
    //    avoid an unhandled promise rejection later. Check the resolved value
    //    to see if it is an error when awaiting.
    const upsertEntityPromise = entities._upsert({
      internalId, ttl, externalIdHash, minAssuranceForResolution
    }).catch(e => e);

    // 6. Encrypt the document for storage.
    const jwe = await _encrypt({document, recipients, recipientChain});

    // 7. Insert the encrypted document.
    try {
      const record = await _insertRegistration({
        internalId,
        externalIdHash,
        documentHash,
        tokenizerId: tokenizer.id,
        jwe,
        ttl,
        creatorHash
      });
      // wait for entity to be upserted as well; note: this does not throw a
      // `DuplicateError` so cannot be confused with one that may be thrown
      // by `_insertRegistration` in the catch below
      const result = await upsertEntityPromise;
      if(result instanceof Error) {
        throw result;
      }
      return record;
    } catch(e) {
      if(e.name !== 'DuplicateError') {
        throw e;
      }
      // document already exists with matching `documentHash` and
      // `externalIdHash`; loop to refresh it, but ensure it isn't treated
      // as a new registration (this handles the case of an expired
      // registration record that wasn't detected by an external caller of
      // this API)
      newRegistration = undefined;
      internalId = undefined;
      continue;
    }
  }
}

/**
 * Encrypts the document either once (with the given recipients) or recursively
 * in a chain (using the recipientChain).
 *
 * @param {object} options - Options hashmap.
 * @param {object} options.document - The document to register.
 * @param {Array<object>} options.recipients - See `register()` docstring.
 * @param {Array<Array<object>>} options.recipientChain - See `register()`
 *   docstring.
 *
 * @returns {Promise<object>} Resolves with the JWE, the result of encryption.
 */
export async function _encrypt({document, recipients, recipientChain}) {
  const keyResolver = createKeyResolver();
  const cipher = new Cipher();

  if(recipients) {
    recipientChain = [recipients];
  }

  let result = document;
  for(const recipientSet of recipientChain) {
    result = await cipher.encryptObject({
      obj: result, recipients: recipientSet, keyResolver
    });
  }

  return result;
}

/**
 * Generates a random `internalId`. See `documents.register` for more details.
 *
 * @returns {Promise<Buffer>} A random `internalId`.
 */
export async function _generateInternalId() {
  return Buffer.from(await idGenerator.generate());
}

/**
 * Tokenizes the registration information.
 *
 * @param {object} options - Options to use.
 * @param {object} [options.tokenizer] - Optional tokenizer to use.
 * @param {string} options.externalId - The external ID to use.
 * @param {object} options.document - The registration document.
 * @param {string} [options.creator] - An optional registration creator.
 *
 * @returns {Promise<object>} The tokenized registration information.
 */
export async function _tokenizeRegistration(
  {tokenizer, externalId, document, creator} = {}) {
  assert.string(externalId, 'externalId');
  assert.object(document, 'document');

  // 1. Get the current tokenizer and its HMAC API.
  if(!tokenizer) {
    tokenizer = await tokenizers.getCurrent();
  }
  const {hmac} = tokenizer;

  // 2. Hmac the `externalId` and the document in parallel.
  // Note: `externalId` and document are HMAC'd to help mitigate against the
  // threat of a stolen database. Once HMAC'd, dictionary attacks may be more
  // difficult -- particularly if the HMAC material is in an HSM.
  const promises = [
    _hmacString({hmac, value: externalId}),
    _hmacDocument({hmac, document})
  ];
  if(creator) {
    promises.push(_hmacString({hmac, value: creator}));
  }
  const [externalIdHash, documentHash, creatorHash] =
    await Promise.all(promises);
  return {tokenizer, externalIdHash, documentHash, creatorHash};
}

/**
 * Retrieves a registration record by `externalIdHash` and `documentHash`.
 *
 * @param {object} options - Options to use.
 * @param {string} options.externalIdHash - The external ID hash.
 * @param {string} options.documentHash - The document hash.
 * @param {boolean} [options.explain] - Set to true to return database query
 *   explain information instead of executing database queries.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with the registration
 *   record or an ExplainObject if `explain=true`.
 */
export async function _getRegistrationRecord(
  {externalIdHash, documentHash, explain = false} = {}) {
  const query = {
    'registration.externalIdHash': externalIdHash,
    'registration.documentHash': documentHash
  };

  const projection = {_id: 0};
  const collection = database.collections['tokenization-registration'];

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
    if(now > record.registration.expires) {
      record = null;
    }
  }
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Document not found.',
      'NotFoundError', details);
  }
  return record;
}

async function _insertRegistration({
  internalId,
  externalIdHash,
  documentHash,
  tokenizerId,
  jwe,
  ttl,
  creatorHash
}) {
  const collection = database.collections['tokenization-registration'];
  const now = Date.now();
  const meta = {created: now, updated: now};
  const record = {
    meta,
    registration: {
      internalId,
      externalIdHash,
      documentHash,
      tokenizerId,
      jwe,
      expires: new Date(now + ttl)
    }
  };
  if(creatorHash) {
    record.registration.creatorHash = [creatorHash];
  }
  try {
    await collection.insertOne(record);
  } catch(e) {
    if(!database.isDuplicateError(e)) {
      throw e;
    }
    throw new BedrockError(
      'Duplicate document.',
      'DuplicateError', {
        public: true,
        httpStatusCode: 409
      }, e);
  }
  return record;
}

export async function _refresh({
  externalIdHash, documentHash, ttl, creatorHash, explain = false
} = {}) {
  const query = {
    'registration.externalIdHash': externalIdHash,
    'registration.documentHash': documentHash
  };
  const now = Date.now();
  const update = {
    // only extend expiration period, do not shorten it; must use `$max`
    // because we want to find the document even if we don't update `expires`
    $max: {'registration.expires': new Date(now + ttl)},
    $set: {'meta.updated': now}
  };
  if(creatorHash) {
    update.$addToSet = {'registration.creatorHash': creatorHash};
  }
  const collection = database.collections['tokenization-registration'];
  const projection = {_id: 0};

  if(explain) {
    // 'find().limit(1)' is used here because 'findOneAndUpdate()' doesn't
    // return a cursor which allows the use of the explain function.
    const cursor = await collection.find(query, {projection}).limit(1);
    return cursor.explain('executionStats');
  }

  const result = await collection.findOneAndUpdate(
    query, update, {
      projection,
      returnNewDocument: true,
      promoteBuffers: true,
      ...database.writeOptions
    });
  // return whether update occurred and new record if it did
  return {updated: result.lastErrorObject.n !== 0, record: result.value};
}

async function _hmacDocument({hmac, document}) {
  // ensure document is in canonical form before hashing
  const value = canonicalize(document);
  return _hmacString({hmac, value});
}

export async function _hmacString({hmac, value}) {
  const data = TEXT_ENCODER.encode(value);
  const signature = await hmac.sign({data});
  // multibase encode hash for future proofing
  // 18 = 0x12 means sha2-256
  // 32 is the digest length in bytes
  return Buffer.concat([Buffer.from([18, 32]), signature]);
}

/**
 * Retrieves the total count of documents matching the given query.
 *
 * @param {object} options - The options to use.
 * @param {object} [options.query={}] - The query to use.
 *
 * @returns {Promise<object>} Resolves to an object containing the total count
 *   of documents that matched the query.
 */
export async function getCount({query = {}} = {}) {
  const collection = database.collections['tokenization-registration'];
  return {count: await collection.countDocuments(query)};
}

/**
 * An object containing information on the query plan.
 *
 * @typedef {object} ExplainObject
 */
