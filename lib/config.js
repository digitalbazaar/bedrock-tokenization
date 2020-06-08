/*
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from 'bedrock';

config.tokenization = {};
config.tokenization.kmsModule = 'ssm-v1';
config.tokenization.defaultVersionOptions = {
  // sizes are in bytes
  batchIdSize: 16,
  batchIndexSize: 1,
  // max tokens in a given batch, must be <= max supported by `batchIndexSize`
  batchTokenCount: 100
};
