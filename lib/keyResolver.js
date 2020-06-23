/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import didIo from 'did-io';
import {driver} from 'did-method-key';

// Config did-io to support did:key driver
didIo.use('key', driver());

export function createKeyResolver() {
  return async function keyResolver({id} = {}) {
    if(!id.startsWith('did:')) {
      throw new Error(`Key ID "${id}" not supported in resolver.`);
    }
    return didIo.get({did: id});
  };
}
