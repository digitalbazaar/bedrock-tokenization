/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from '@bedrock/core';

config.tokenization = {};
// option to control whether pairwise tokens can be looked up by value;
// applications that do not need to do so should not enable this index to
// save significant space
config.tokenization.ensurePairwiseTokenValueIndex = false;
// option to control whether expired records are automatically removed via
// built-in MongoDB TTL indexes (true = yes, false = no); if this is set to
// `false` on a system where it was previously set to `true`, then any instance
// running with this configuration will NOT delete existing TTL indexes;
// setting it to `true` on a system where it was previously `false` WILL result
// in the creation of new TTL indexes
config.tokenization.autoRemoveExpiredRecords = false;
config.tokenization.tokenCreationConcurrency = 5;
config.tokenization.defaultVersionOptions = {
  // sizes are in bytes
  batchIdSize: 16,
  batchSaltSize: 16,
  // max tokens in a given batch, must be <= max supported by the token
  // resolution bitstring length; note that, with the current implementation,
  // this max configurable value is 256; the implementation must change to use
  // a larger token batch resolution bitstring if there is a need to allow
  // larger token batches
  batchTokenCount: 100,
  /* Note: Because tokens are stored in batches (to significantly increase
  storage efficiency), they all expire together. This necessarily means that
  individual tokens do not have the same constant TTL; some in a given batch
  live longer than others. A token is alive from issuance time until batch
  expiration time. The batch TTL therefore expresses the maximum TTL for any
  given token, but some tokens in a batch may not live that long. The
  implementation, however, ensures that the minimum TTL for a token is half of
  that maximum TTL, i.e., no new tokens will be issued from a batch that has
  lived for more than half its TTL. This means that the `ttl` below gives an
  easy way to reason about token limits: it represents the maximum time any
  batch or token in a batch may live and half of its value represents the
  shortest time any given token could live.

  Note that it is also important that new token batches not have shorter TTLs
  while existing valid token batches have not expired. If new token batches
  have a shorter TTL, then they could expire prior to existing valid token
  batches. Since only the last created token batch is tracked in the associated
  entity record, those older but still unexpired token batches would become
  invalidated if an application makes a call reset an entity's
  `minAssuranceForResolution` to some value. This call is gated on ensuring the
  last created token batch is invalid or expired and results in invalidating
  all other unpinned token batches on success. While this is not a security
  problem, it could have a detrimental affect on UX. */
  // time to live in milliseconds, default to 240 days
  ttl: 240 * 24 * 60 * 60 * 1000
};
