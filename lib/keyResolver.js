const didIo = require('did-io');
// Config did-io to support did:key driver
didIo.use('key', require('did-method-key').driver());

/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
export async function createKeyResolver() {
  return async function keyResolver({id} = {}) {
    if(!id.startsWith('did:')) {
      throw new Error(`Key id not supported in resolver: '${id}'.`);
    }
    return await didIo.get({did: id});
  };
}
