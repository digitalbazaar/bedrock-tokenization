/*!
 * Copyright (c) 2020-2021 Digital Bazaar, Inc. All rights reserved.
 */
import * as crypto from 'crypto';

// AES-KW uses this specific fixed IV:
const AES_KW_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

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
    const cipher = crypto.createCipheriv('id-aes256-wrap', kek, AES_KW_IV);
    return Buffer.concat([cipher.update(unwrappedKey), cipher.final()]);
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
      const cipher = crypto.createDecipheriv('id-aes256-wrap', kek, AES_KW_IV);
      return Buffer.concat([cipher.update(wrappedKey), cipher.final()]);
    } catch(e) {
      // decryption failed
      return null;
    }
  }
}

export async function createKek({keyData}) {
  return new Kek(keyData);
}
