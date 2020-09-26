/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from 'bedrock';
import * as database from 'bedrock-mongodb';
import {tokenizers} from 'bedrock-tokenizer';
import {IdGenerator} from 'bnid';
import canonicalize from 'canonicalize';
import {Cipher} from 'minimal-cipher';
import {promisify} from 'util';
import {createKeyResolver} from './keyResolver.js';
import {TextEncoder} from 'util';
const {util: {BedrockError}} = bedrock;

const TEXT_ENCODER = new TextEncoder();

// 128 bit random id generator
const idGenerator = new IdGenerator({bitLength: 128});

bedrock.events.on('bedrock-mongodb.ready', async () => {
  await promisify(database.openCollections)(['tokenization-registration']);

  // `externalIdHash` should be a shard key
  await promisify(database.createIndexes)([{
    // there may be multiple documents that match the same external ID hash
    // and queries must be supported to find them all...
    // but do not allow multiple `internalId`s for the same `hash` and
    // `externalIdHash`
    collection: 'tokenization-registration',
    fields: {'registration.externalIdHash': 1, 'registration.documentHash': 1},
    options: {unique: true, background: false}
  }, {
    // automatically expire registrations with an `expires` date field
    collection: 'tokenization-registration',
    fields: {'registration.expires': 1},
    options: {
      unique: false,
      background: false,
      expireAfterSeconds: 0
    }
  }]);
});

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
 * new `internalId` will be generated.
 *
 * Optional `creator` can be provided to identify the party that created the
 * registration. This information will be HMAC'd before being stored in the
 * database and thus cannot be reversed but only verified by parties that
 * have access to the original data and a capability to use the HMAC key.
 *
 * @param {object} options - Options to use.
 * @param {Buffer} [options.internalId] - An optional internal ID to use, if
 *   not provided, one will be generated or reused if there is a matching
 *   document registration.
 * @param {string} options.externalId - An application-specific string that
 *   unambiguously identifies a particular entity to the application.
 * @param {object} options.document - The document to register.
 * @param {array} options.recipients - A list of recipients identified by
 *   key agreement keys. An ephemeral ECDH key will be generated and used to
 *   derive shared KEKs that will wrap a randomly generated CEK. The CEK will
 *   be used to encrypt the document. Each recipient in the `recipients` array
 *   will be capable of decrypting the document.
 * @param {number} options.ttl - The number of milliseconds until the
 *   document should expire.
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
 *   not a registration is expected to be new.
 *
 * @returns {Promise<object>} An object with the registration record.
 */
export async function register({
  internalId, externalId, document, recipients, ttl, creator,
  tokenizer, externalIdHash, documentHash, creatorHash, newRegistration
} = {}) {
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
    if(!newRegistration &&
      await _refresh({externalIdHash, documentHash, ttl, creatorHash})) {
      // doc already registered and now refreshed, no need to encrypt; return
      // existing record
      return _getRegistrationRecord({externalIdHash, documentHash});
    }

    // at this point either a document associated with the external ID and
    // hash doesn't exist or the same expiration date *happened* to be set by
    // two different processes...

    // assume the more common case that there is no such document with the
    // given `externalIdHash` and `documentHash` and go ahead and generate an
    // `internalId` for inserting the document and encrypt it; if incorrect, the
    // `internalId` won't be set and the encrypted data won't be used

    // 4. Generate a new random internal ID to associate with `externalId` if
    //    none has been set yet.
    if(!internalId) {
      internalId = await _generateInternalId();
    }

    // 5. Encrypt the document for storage.
    const cipher = new Cipher();
    const obj = document;
    const keyResolver = createKeyResolver();
    const jwe = await cipher.encryptObject({obj, recipients, keyResolver});

    // 6. Insert the encrypted document.
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
      return record;
    } catch(e) {
      if(e.name !== 'DuplicateError') {
        throw e;
      }
      // document already exists with matching `documentHash` and
      // `externalIdHash`; loop to refresh it
      continue;
    }
  }
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
 * @param {string} options.document - The registration document.
 * @param {string} [options.creator] - An optional registration creator.
 *
 * @returns {Promise<object>} The tokenized registration information.
 */
export async function _tokenizeRegistration(
  {tokenizer, externalId, document, creator} = {}) {
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
 *
 * @returns {Promise<object>} The registration record.
 */
export async function _getRegistrationRecord(
  {externalIdHash, documentHash} = {}) {
  const query = {
    'registration.externalIdHash': externalIdHash,
    'registration.documentHash': documentHash
  };
  const projection = {_id: 0};
  const collection = database.collections['tokenization-registration'];
  const record = await collection.findOne(query, {projection});
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
  let record = {
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
    const result = await collection.insertOne(record, database.writeOptions);
    record = result.ops[0];
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

async function _refresh({externalIdHash, documentHash, ttl, creatorHash}) {
  const query = {
    'registration.externalIdHash': externalIdHash,
    'registration.documentHash': documentHash
  };
  const now = Date.now();
  const update = {
    $set: {
      'meta.updated': now,
      'registration.expires': new Date(now + ttl)
    }
  };
  if(creatorHash) {
    update.$addToSet = {
      'registration.creatorHash': creatorHash
    };
  }
  const collection = database.collections['tokenization-registration'];
  const result = await collection.updateOne(
    query, update, database.writeOptions);
  // return `true` if the update occurred (existing document found)
  return result.result.n !== 0;
}

async function _hmacDocument({hmac, document}) {
  // ensure document is in canonical form before hashing
  const value = canonicalize(document);
  return _hmacString({hmac, value});
}

async function _hmacString({hmac, value}) {
  const data = TEXT_ENCODER.encode(value);
  const signature = base64url.decode(await hmac.sign({data}));
  // multibase encode hash for future proofing
  // 0x12 means sha2-256
  // 32 is the digest length in bytes
  return Buffer.concat([Buffer.from([0x12, 32]), signature]);
}
