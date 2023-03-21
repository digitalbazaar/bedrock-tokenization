/*!
 * Copyright (c) 2020-2023 Digital Bazaar, Inc. All rights reserved.
 */
import * as batchVersions from '../batchVersions.js';
import * as documents from '../documents.js';
import {createTokens as _createTokens} from './batches.js';
import assert from 'assert-plus';
import {tokenizers} from '@bedrock/tokenizer';

// expose public functions
export {resolve, resolveToEntity, resolveToInternalId} from './resolve.js';
export {
  invalidateBatches as invalidateTokenBatches,
  updateEntityWithNoValidBatches as updateEntityWithNoValidTokenBatches
} from './batches.js';

// re-export functions for testing
export {
  get as _getPairwiseToken,
  upsert as _upsertPairwiseToken
} from './pairwise.js';
export {
  _claimTokens, getBatch as _getBatch, updateBatch as _updateBatch
} from './batches.js';

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
 * @param {number} [options.minAssuranceForResolution=2] - Minimum level of
 *   assurance required for token resolution. To use an unpinned token batch,
 *   pass `-1`.
 *
 * @returns {Promise<object>} An object with `registrationRecord` as the
 *   resulting registration record and `tokens` as an array of created tokens.
 */
export async function registerDocumentAndCreate({
  registerOptions, attributes = new Uint8Array(), tokenCount,
  minAssuranceForResolution = 2
} = {}) {
  assert.object(registerOptions, 'registerOptions');
  assert.number(tokenCount, 'tokenCount');
  assert.optionalNumber(minAssuranceForResolution, 'minAssuranceForResolution');

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

  // get the current tokenizer
  const tokenizer = await tokenizers.getCurrent();

  // tokenize registration information and get batch version associated with
  // the tokenizer
  const {externalId, document, creator} = registerOptions;
  const [
    {externalIdHash, documentHash, creatorHash},
    {batchVersion}
  ] = await Promise.all([
    documents._tokenizeRegistration({tokenizer, externalId, document, creator}),
    batchVersions.ensureBatchVersion({tokenizerId: tokenizer.id})
  ]);

  // ensure register options TTL sufficiently covers batch version TTL
  const {options: {ttl: batchVersionTtl}} = batchVersion;
  registerOptions = {
    ...registerOptions,
    ttl: Math.max(batchVersionTtl, registerOptions.ttl)
  };

  while(true) {
    // try to obtain an existing `internalId` for given registration options
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
    const newRegistration = !registrationRecord;
    const registerPromise = documents.register({
      ...registerOptions,
      internalId,
      tokenizer, externalIdHash, documentHash, creatorHash,
      minAssuranceForResolution,
      newRegistration
    });
    const [registrationResult, createResult] = await Promise.all([
      registerPromise,
      _createTokens({
        internalId, attributes, tokenCount, minAssuranceForResolution,
        tokenizer, batchVersion, registerPromise, newRegistration
      })
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
 * @param {number} [options.minAssuranceForResolution=2] - Minimum level of
 *   assurance required for token resolution. To use an unpinned token batch,
 *   pass `-1`.
 *
 * @returns {object} An object with `tokens` as an array of created tokens.
 */
export async function create({
  internalId, attributes = new Uint8Array(), tokenCount,
  minAssuranceForResolution = 2
} = {}) {
  return _createTokens({
    internalId, attributes, tokenCount, minAssuranceForResolution
  });
}
