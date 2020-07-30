/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import {default as crypto} from 'isomorphic-webcrypto';

class Kek {
  constructor(key) {
    this.key = key;
    this.algorithm = {name: 'A256KW'};
  }

  /**
   * Wraps a cryptographic key.
   *
   * @param {Object} options - The options to use.
   * @param {Uint8Array} options.unwrappedKey - The key material as a
   *   `Uint8Array`.
   *
   * @returns {Promise<Uint8Array>} The wrapped key bytes.
   */
  async wrapKey({unwrappedKey}) {
    const kek = this.key;
    // Note: `AES-GCM` algorithm name doesn't matter; will be exported raw.
    const extractable = true;
    const length = unwrappedKey.length * 8;
    unwrappedKey = await crypto.subtle.importKey(
      'raw', unwrappedKey, {name: 'AES-GCM', length},
      extractable, ['encrypt']);
    const wrappedKey = await crypto.subtle.wrapKey(
      'raw', unwrappedKey, kek, kek.algorithm);
    return new Uint8Array(wrappedKey);
  }

  /**
   * Unwraps a cryptographic key.
   *
   * @param {Object} options - The options to use.
   * @param {Uint8Array} options.wrappedKey - The wrapped key material.
   *
   * @returns {Promise<Uint8Array>} Resolves to the key bytes or null if
   *   the unwrapping fails because the key does not match.
   */
  async unwrapKey({wrappedKey}) {
    const kek = this.key;
    try {
      // Note: `AES-GCM` algorithm name doesn't matter; will be exported raw.
      const extractable = true;
      const key = await crypto.subtle.unwrapKey(
        'raw', wrappedKey, kek, kek.algorithm,
        {name: 'AES-GCM'}, extractable, ['encrypt']);
      const keyBytes = await crypto.subtle.exportKey('raw', key);
      return new Uint8Array(keyBytes);
    } catch(e) {
      // decryption failed
      return null;
    }
  }
}

export async function createKek({keyData}) {
  const extractable = true;
  const key = await crypto.subtle.importKey(
    'raw', keyData, {name: 'AES-KW', length: 256}, extractable,
    ['wrapKey', 'unwrapKey']);
  return new Kek(key);
}
