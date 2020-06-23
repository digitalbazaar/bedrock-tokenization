/*
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from 'bedrock';

config.tokenization = {};
config.tokenization.tokenCreationConcurrency = 5;
config.tokenization.defaultVersionOptions = {
  // sizes are in bytes
  batchIdSize: 16,
  batchSaltSize: 16,
  // max tokens in a given batch, must be <= max supported by `batchIndexSize`
  batchTokenCount: 100
};
