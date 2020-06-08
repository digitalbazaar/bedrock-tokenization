/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
export async function createKeyResolver() {
  return async function keyResolver({id} = {}) {
    // TODO: implement `did:key` resolver
    throw new Error('bedrock-tokenization "keyResolver" not implemented');
  };
}
