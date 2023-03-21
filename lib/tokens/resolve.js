/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from '@bedrock/core';
import * as entities from '../entities.js';
import {
  getBatch as _getBatch,
  updateBatch as _updateBatch
} from './batches.js';
import {
  get as _getPairwiseToken,
  upsert as _upsertPairwiseToken
} from './pairwise.js';
import {parse as _parseToken} from './format.js';
import {Bitstring} from '@digitalbazaar/bitstring';

const {util: {BedrockError}} = bedrock;

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
 * @param {Buffer} options.token - Decoded token to resolve.
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
} = {}) {
  // parse token
  const {batchId, index} = await _parseToken({token});

  while(true) {
    // get batch document
    const {tokenBatch} = await _getBatch({id: batchId});
    const {internalId, expires} = tokenBatch;

    // determine token pinned/unpinned status
    const isUnpinned = tokenBatch.minAssuranceForResolution === -1;

    /* Note: If the token batch is unpinned, start fetching the entity record
    to get the inherited `minAssuranceForResolution` to use. */
    let entityRecordPromise;
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
          // token resolved for same requester; note we don't need to update
          // the pairwise token record (to increase its `expires` value) if
          // it already exists because it's always the same TTL for every token
          // in the same batch... and a new batch will trigger an upsert
          tokenRecord = await _getPairwiseToken({internalId, requester});
          if(!tokenRecord) {
            /* Note: Since token batches are updated concurrently with setting
            pairwise tokens, it's possible for the token batch to be updated
            prior to the pairwise token being created -- which means we must
            upsert one here. */
            tokenRecord = await _upsertPairwiseToken(
              {internalId, requester, expires});
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
        ({pairwiseToken} = await _markTokenResolved({
          batchId, index, internalId, requester, compressed,
          encodedRequester, requesterList, resolvedList, expires
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
      // store last level of assurance failure in `entityRecord` with
      // `batchId` value to enable later optional checks when considering
      // lowering entity's `minAssuranceForResolution`
      if(isUnpinned) {
        const {entity} = entityRecord;
        await entities._setLastAssuranceFailedTokenResolution(
          {entity, tokenBatch, date: new Date()});
      }
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
    return {
      pairwiseToken, internalId, isUnpinned, minAssuranceForResolution,
      validUntil: expires
    };
  }
}

/**
 * Resolves a token to the entity to which it is linked. The entity's
 * `internalId` should never be shared outside of the system that uses this
 * module. This function is useful for obtaining the entity associated with
 * a token that is still valid. For use cases where it's desirable to be able
 * to call the same API both with and without the token validity check, a
 * flag, `allowInvalidatedTokens`, can be passed to disable the check.
 *
 * This function provides an atomic mechanism that will only obtain an entity
 * associated with a token if that token is still valid (if the validity check
 * is not disabled via `allowInvalidatedTokens`). This atomicity is useful for
 * attempting to make subsequent changes to the returned entity (such as
 * setting its `minAssuranceForResolution`) that can be aborted if concurrent
 * token batch invalidation occurs.
 *
 * @param {object} options - Options to use.
 * @param {string} options.token - The token to resolve.
 * @param {boolean} [options.allowInvalidatedTokens=false] - If true, will
 *   allow invalidated tokens to be resolved to an entity (the validity check
 *   will be skipped).
 *
 * @returns {Promise<object>} The entity record.
 */
export async function resolveToEntity({
  token, allowInvalidatedTokens = false
} = {}) {
  // parse token
  const {batchId} = await _parseToken({token});

  // get batch document
  const {tokenBatch} = await _getBatch({id: batchId});
  const {internalId} = tokenBatch;

  // determine token pinned/unpinned status
  const isUnpinned = tokenBatch.minAssuranceForResolution === -1;

  // get associated entity
  const entityRecord = await entities.get({internalId});

  // if checking validity...
  // if token is unpinned, ensure token has not been invalidated; check this by
  // ensuring the `batchInvalidationCount` matches the entity record's
  if(!allowInvalidatedTokens && isUnpinned &&
    tokenBatch.batchInvalidationCount !==
    entityRecord.entity.batchInvalidationCount) {
    throw new BedrockError(
      'Token has been invalidated.',
      'NotAllowedError', {
        public: true,
        httpStatusCode: 403
      });
  }

  return entityRecord;
}

/**
 * Resolves a token to the `internalId` to which it is linked. This
 * `internalId` should never be shared outside of the system that uses this
 * module. This function is useful for obtaining the `internalId` associated
 * with a token such that registered, encrypted documents associated with the
 * `internalId` can be retrieved -- regardless of the invalidation status
 * of the given token.
 *
 * **IMPORTANT**: If the invalidation status of the token matters, use
 * `resolveToEntity` instead.
 *
 * @param {object} options - Options to use.
 * @param {string} options.token - The token to resolve.
 *
 * @returns {Promise<object>} An object with the `internalId`.
 */
export async function resolveToInternalId({token} = {}) {
  // parse token
  const {batchId} = await _parseToken({token});

  // get batch document
  const {tokenBatch} = await _getBatch({id: batchId});
  const {internalId} = tokenBatch;

  // special case resolve to internal ID with flag set
  return {internalId};
}

async function _markTokenResolved({
  batchId, index, internalId, requester, compressed,
  encodedRequester, requesterList, resolvedList, expires
}) {
  // concurrently create a pairwise token for the requester if one does not
  // exist and update requester's resolution info for the token batch
  const [{pairwiseToken: {value: pairwiseToken}}] = await Promise.all([
    _upsertPairwiseToken({internalId, requester, expires}),
    _updateBatchResolvedList({
      batchId, requesterList, resolvedList, index, compressed, encodedRequester
    })
  ]);

  return {pairwiseToken};
}

async function _updateBatchResolvedList({
  batchId, requesterList, resolvedList, index, compressed, encodedRequester
}) {
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
    // use `Token` language to avoid expressing "batch" information in any
    // log leak
    throw new BedrockError(
      'Token state changed concurrently.',
      'InvalidStateError', {
        public: true,
        httpStatusCode: 409
      });
  }
}
