/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
//import * as bedrock from 'bedrock';
import './config.js';

import * as documents from './documents.js';
import * as tokens from './tokens.js';
import * as tokenizers from './tokenizers.js';
import * as tokenVersions from './tokenVersions.js';

export {documents, tokens, tokenizers, tokenVersions};

/*
bedrock.events.on('bedrock.ready', async () => {
  // FIXME: control this behavior based on a flag or simple don't have have it
  // here at all -- let an application decide how to create an initial version
  // ... or might want a control to automatically create a new version for
  // a tokenizer if no version exists, based on configuration options or
  // based on the previous version (or based on some options from the database
  // and only then fallback to locally configured options/previous version)

  // auto insert first tokenizer and token version `0` based on config
  const {tokenizerId} = await tokenizers.getCurrent();
  const {batchSize, indexSize} = bedrock.config.tokenization.initialVersion;
  try {
    await tokenVersions.create({id: 0, tokenizerId, batchSize, indexSize});
  } catch(e) {
    if(e.name !== 'DuplicateError') {
      throw e;
    }
    // ignore duplicate initial version
  }
});
*/
