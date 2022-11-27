/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as batchVersions from './batchVersions.js';
import * as bedrock from '@bedrock/core';
import * as documents from './documents.js';
import * as entities from './entities.js';
import {create as _createToken, parse as _parseToken} from './tokenFormat.js';
import {
  getPairwiseToken as _getPairwiseToken,
  upsertPairwiseToken as _upsertPairwiseToken
} from './pairwiseTokens.js';
import assert from 'assert-plus';
import {Bitstring} from '@digitalbazaar/bitstring';
import {
  _claimTokens,
  createTokens as _createTokens,
  getBatch as _getBatch,
  updateBatch as _updateBatch
} from './tokenBatches.js';
import {tokenizers} from '@bedrock/tokenizer';

const {util: {BedrockError}} = bedrock;

// expose function to invalidate token batches
export {invalidateBatches as invalidateTokenBatches} from './tokenBatches.js';

// re-export functions for testing
export {
  _claimTokens, _getBatch, _getPairwiseToken, _upsertPairwiseToken,
  _updateBatch
};

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
    /* Note: Document registration expiration includes a grace period to ensure
    that document registration records will never reasonably be expunged prior
    to associated token batches. This grace period is only needed because the
    `expires` propery of token batches will be computed later using a different
    `Date.now()` value that could be later. It is meant to cover the execution
    of the in-parallel creation of document registration records and tokens
    where token creation could stall and result in a slightly later expiration
    period. */
    // grace period is 1 hour, which is more than sufficient to handle delays
    // in token creation
    ttl: Math.max(batchVersionTtl + 1000 * 60 * 60, registerOptions.ttl)
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
        tokenizer, batchVersion,
        externalIdHash, registerPromise, newRegistration
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
 * @param {boolean} [options.allowResolvedInvalidatedTokens=false] - If true,
 *   will allow already resolved but subsequently invalidated tokens to be
 *   resolved again.
 *
 * @returns {object} An object containing the Uint8Array `pairwiseToken`.
 */
export async function resolve({
  requester, token, levelOfAssurance, allowResolvedInvalidatedTokens = false
}) {
  // parse token
  const {batchId, index} = await _parseToken({token});

  while(true) {
    // get batch document
    // FIXME: get `expires` as well to pass for pairwise token `expires`
    const {tokenBatch} = await _getBatch({id: batchId});
    const {internalId} = tokenBatch;

    // determine token pinned/unpinned status
    const isUnpinned = tokenBatch.minAssuranceForResolution === -1;

    // FIXME: add any backwards compatibility code that will increase
    // entity and document registration `expires` for old token batches
    // ... if token batch was created before date X -- then apply the updates

    /* Note: If the token batch is unpinned, start fetching the entity record
    to get the inherited `minAssuranceForResolution` to use. */
    let entityRecordPromise;
    // FIXME: also fetch the entity record if the token batch creation date
    // is before X -- allowing for backwards compatibility updates
    if(isUnpinned) {
      // resolve to error if this call fails to ensure that we do not have
      // an unhandled promise rejection should another failure occur before
      // we await this promise; then check the resolved value for an error
      // and throw it when we do await later
      entityRecordPromise = entities.get({internalId}).catch(e => e);
    }

    /* Note: Always mark the token as resolved against the given party, even
    if we will ultimately report that the assurance level was too low to
    resolve it. This ensures that the token's resolution is bound to the
    resolving party as an anti-correlation measure. No other party could later
    resolve the same token provided that greater identity assurance is provided;
    only the party that has been given the party and first attempted resolution
    will be able to resolve it later (if higher identity assurance is given or
    if the token's batch is unpinned and the minimum assurance for resolution
    is lowered). */

    // prepare to do pairwise resolution...
    const {resolvedList: compressed, resolution = {}} = tokenBatch;

    // parse resolved bitstring
    const resolvedList = new Bitstring({
      buffer: await Bitstring.uncompressBits({compressed})
    });

    // find resolution list for `requester`
    const encodedRequester = base64url.encode(requester);
    const requesterList = resolution[encodedRequester];

    // see if token is already resolved
    let tokenRecord;

    // Note: Unpinned token batch invalidation is not retroactive; if a token
    // was already resolved before invalidation, it remains resolved.
    if(resolvedList.get(index)) {
      // token already resolved, see if requester matches
      if(requesterList) {
        const bs = new Bitstring({
          buffer: await Bitstring.uncompressBits({compressed: requesterList})
        });
        if(bs.get(index)) {
          // token resolved for same requester
          tokenRecord = await _getPairwiseToken({internalId, requester});
          if(!tokenRecord) {
            // FIXME: if token batch is updated concurrently below ... it will
            // create an additional case where the pairwise token may not be
            // set here -- so this is handled by generating the pairwise token
            // now by calling `_upsertPairwiseToken` ... but more analysis must
            // be done to ensure that it is not possible for a different
            // requester to grab the pairwise token before this is implemented
          }
        }
      }
      if(!tokenRecord) {
        // token already resolved to another requester, can only be
        // scope-resolved once
        throw new BedrockError(
          'Token already used.',
          'NotAllowedError', {
            public: true,
            httpStatusCode: 400
          });
      }
    }

    // await any parallel potential entity record lookup to check for
    // unpinned token batch invalidation prior to resolution (promise will
    // be undefined if token is pinned)
    const entityRecord = await entityRecordPromise;
    if(entityRecord instanceof Error) {
      throw entityRecord;
    }

    // unless resolving invalid tokens is permitted, ensure that an unpinned
    // token has not been invalidated; check this by ensuring the
    // `batchInvalidationCount` matches the entity record's
    if(!allowResolvedInvalidatedTokens &&
      isUnpinned && tokenBatch.batchInvalidationCount !==
      entityRecord.entity.batchInvalidationCount) {
      throw new BedrockError(
        'Token has been invalidated.',
        'NotAllowedError', {
          public: true,
          httpStatusCode: 403
        });
    }

    let pairwiseToken;
    if(tokenRecord) {
      // token was previously resolved, so get existent pairwise token
      ({pairwiseToken: {value: pairwiseToken}} = tokenRecord);
    } else {
      // token is not yet resolved, attempt to resolve it for `requester`...
      try {
        // FIXME: pass `expires` to enable TTL on pairwise token records
        ({pairwiseToken} = await _markTokenResolved({
          batchId, index, internalId, requester, compressed,
          encodedRequester, requesterList, resolvedList
        }));
      } catch(e) {
        if(e.name === 'InvalidStateError') {
          // another process resolved a token concurrently, try again
          continue;
        }
        throw e;
      }
    }

    // the token inherits `minAssuranceForResolution` from the entity if it is
    // unpinned, otherwise, it comes from its token batch
    const minAssuranceForResolution = isUnpinned ?
      entityRecord.entity.minAssuranceForResolution :
      tokenBatch.minAssuranceForResolution;

    // unless resolving invalid tokens is permitted, compare the
    // `levelOfAssurance` passed in to the `minAssuranceForResolution`
    // for the token
    if(!allowResolvedInvalidatedTokens &&
      levelOfAssurance < minAssuranceForResolution) {
      throw new BedrockError(
        'Could not resolve token; minimum level of assurance not met.',
        'NotAllowedError', {
          levelOfAssurance,
          minAssuranceForResolution,
          public: true,
          httpStatusCode: 403
        });
    }

    // finally, return pairwise token, internal ID, and other token info
    return {pairwiseToken, internalId, isUnpinned, minAssuranceForResolution};
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

// FIXME: accept `batchVersion` to get `expires` for pairwise token
async function _markTokenResolved({
  batchId, index, internalId, requester, compressed,
  encodedRequester, requesterList, resolvedList
}) {
  // FIXME: rewrite this to run updating the token batch and upserting the
  // pairwise token concurrently, noting that if the existence of a pairwise
  // record was previously gating updating the token batch, this will create
  // additional possible states that now must be accounted for elsewhere

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
  const result = await _updateBatch({
    batchId, compressed, resolvedList, encodedRequester, requesterList
  });
  if(result.result.n === 0) {
    throw new BedrockError(
      'Batch state changed concurrently.',
      'InvalidStateError', {
        public: true,
        httpStatusCode: 409
      });
  }

  return {pairwiseToken};
}
