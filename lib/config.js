/*
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from 'bedrock';

config.tokenization = {};
config.tokenization.kmsModule = 'ssm-v1';
config.tokenization.initialVersion = {
  // sizes are in bytes
  batchSize: 16,
  indexSize: 2
};
