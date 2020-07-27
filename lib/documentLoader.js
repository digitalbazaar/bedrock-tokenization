/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import fs from 'fs';

// TODO: move to another npm package
const CIT_CONTEXT = JSON.parse(fs.readFileSync(
  __dirname + '/cit-v1.jsonld', 'utf8'));
export const CIT_CONTEXT_URL = 'https://w3id.org/cit/v1.jsonld';

export async function documentLoader(url) {
  if(url !== CIT_CONTEXT_URL) {
    throw new Error(`Loading document "${url}" is not allowed.`);
  }
  return JSON.stringify(CIT_CONTEXT);
  // FIXME: use this return value once cborld module is patched
  /*
  return {
    contextUrl: null,
    document: CIT_CONTEXT,
    documentUrl: url
  };*/
}
