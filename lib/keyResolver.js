/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {didIo} from 'bedrock-did-io';
import {driver} from '@digitalbazaar/did-method-key';

// Config did-io to support did:key driver
didIo.use(driver());

export function createKeyResolver() {
  return async function keyResolver({id} = {}) {
    if(!id.startsWith('did:')) {
      throw new Error(`Key ID "${id}" not supported in resolver.`);
    }
    return didIo.get({did: id});
  };
}
