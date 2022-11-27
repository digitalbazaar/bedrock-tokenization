/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from '@bedrock/core';

config.tokenization = {};
config.tokenization.tokenCreationConcurrency = 5;
config.tokenization.defaultVersionOptions = {
  // sizes are in bytes
  batchIdSize: 16,
  batchSaltSize: 16,
  // max tokens in a given batch, must be <= max supported by `batchIndexSize`
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
  shortest time any given token could live. */
  // time to live in milliseconds, default to 60 days
  ttl: 60 * 24 * 60 * 60 * 1000
};
