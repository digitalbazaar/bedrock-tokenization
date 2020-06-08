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
bedrock.events.on('bedrock-mongodb.ready', async () => {
  // TODO: if storing version options in the database is desired,
  // add code here to insert version options from config, ignoring
  // duplicate error
});
*/
