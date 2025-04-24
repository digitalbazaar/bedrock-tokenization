/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import * as base58 from 'base58-universal';
import * as batchVersions from '../batchVersions.js';
import * as bedrock from '@bedrock/core';
import {
  decode as cborldDecode, encode as cborldEncode
} from '@digitalbazaar/cborld';
import citContext from 'cit-context';
import {createKek} from './aeskw.js';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {tokenizers} from '@bedrock/tokenizer';

const {constants: citConstants, documentLoader} = citContext;
const {CONTEXT_URL: CIT_CONTEXT_URL} = citConstants;
const {randomBytes, timingSafeEqual} = crypto;
const randomBytesAsync = promisify(randomBytes);
const {util: {BedrockError}} = bedrock;

const VERSION_SIZE = 2;

export async function create({
  hmac, batchVersion, tokenBatch, index, attributes
} = {}) {
  const batchId = tokenBatch.id;

  // get version options
  const {id: version, options: {batchIdSize, batchSaltSize}} = batchVersion;

  // build data to encrypt/wrap: batchId|index|aad|padding
  // minimum total = 192-bits, 24 bytes, but can be larger, must be
  // 24 + (n*8) bytes, where n >= 0
  // "aad" is additional authenticated data which is aka "attributes"
  // Note: minimum size is 24 bytes, max is unlimited; size depends on the
  // size of the attributes
  const unwrappedSize = _roundToMultipleOf8(
    batchIdSize + 1 + attributes.length);
  const toWrap = new Uint8Array(unwrappedSize);
  let offset = 0;
  // batch ID, `batchIdSize`, default is 16 bytes
  toWrap.set(batchId, offset);
  // index, 1 byte
  toWrap[offset += batchId.length] = index;
  // attributes (unlimited size, but affects token size, largest it can be
  // without growing the token is 7 bytes, every multiple of 8 thereafter
  // increases the token size by 8), attributes also travel in the
  // clear in the token and their size within the wrapped data must match
  toWrap.set(attributes, offset += 1);
  // random padding for remaining bytes
  offset += attributes.length;
  const padding = await randomBytesAsync(toWrap.length - offset);
  toWrap.set(padding, offset);

  // generate salt based on token version options
  const salt = await randomBytesAsync(batchSaltSize);

  // create KEK via HMAC(batchVersion|salt)
  const kek = await _getKek({hmac, version, salt});

  // wrap `toWrap` as if it were a key, output is 8 more bytes than input
  // per AES-KW spec
  const wrapped = await kek.wrapKey({unwrappedKey: toWrap});

  // build "ConcealedIdToken" payload: batchVersion|salt|wrapped
  // example `tokenSize`:
  // 2 bytes: batchVersion
  // 16 bytes: salt (larger reduces key collisions, but increases token size)
  // 32 bytes: wrapped data (minimum, can be larger by multiples of 8)
  const payloadSize = 2 + salt.length + wrapped.length;
  const payload = new Uint8Array(payloadSize);
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  offset = 0;
  // batchVersion, 2 byte uint16
  dv.setUint16(offset, version);
  // salt
  payload.set(salt, offset += 2);
  // wrapped
  payload.set(wrapped, offset += salt.length);

  // ConcealedIdToken "meta" is "attributes"

  // total token size
  // = 50 bytes minimum with attributes up to 7 bytes in size, then additional
  //   multiples of 8 bytes for every multiple of 8 in attributes size
  const jsonldDocument = {
    '@context': CIT_CONTEXT_URL,
    type: 'ConcealedIdToken',
    meta: `z${base58.encode(attributes)}`,
    payload: `z${base58.encode(payload)}`,
  };
  const token = await cborldEncode({
    jsonldDocument,
    format: 'legacy-singleton',
    documentLoader
  });
  return token;
}

export async function parse({token}) {
  // validate token
  if(!(token instanceof Uint8Array && token.length >= VERSION_SIZE)) {
    throw new TypeError(
      `"token" must be a Uint8Array that is ${VERSION_SIZE} bytes ` +
      'or more in size.');
  }

  // parse token via cborld
  // token is CBOR-LD encoded "ConcealedIdToken" with a
  // "payload" and optional "meta"
  const parsed = {};
  try {
    const {type, payload, meta} = await cborldDecode({
      cborldBytes: token,
      documentLoader
    });
    if(type !== 'ConcealedIdToken') {
      throw new Error(`Invalid token type "${type}".`);
    }

    // decode payload and meta
    if(!(payload && typeof payload === 'string' && payload[0] === 'z')) {
      throw new Error(`Invalid token payload "${payload}".`);
    }
    parsed.payload = base58.decode(payload.substr(1));

    if(meta) {
      if(!(typeof meta === 'string' && meta[0] === 'z')) {
        throw new Error(`Invalid token meta "${meta}".`);
      }
      parsed.attributes = base58.decode(meta.substr(1));
    } else {
      parsed.attributes = new Uint8Array();
    }
  } catch(e) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, e);
  }

  // parse batch version from token payload
  const {payload, attributes} = parsed;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.length);
  const version = dv.getUint16(0);

  // get token version by `version` ID
  const {batchVersion} = await batchVersions.get({id: version});
  const {options: {batchIdSize, batchSaltSize}} = batchVersion;

  // validate payload size is correct given the batch version
  // payload will contain: batchVersion|salt|wrapped
  // batchVersion = 2 bytes
  // salt = batchSaltSize bytes
  // wrapped = _roundToMultipleOf8(batchIdSize + 1(batchIndex) +
  //   attributes.length) + 8
  // Note: `batchVersion` and `salt` map to crypto used to generate a key and
  // will therefore be authenticated via key unwrapping. The `attributes` can
  // be compared against the unwrapped attributes to be integrity checked
  const wrappedSize = _roundToMultipleOf8(
    batchIdSize + 1 + attributes.length) + 8;
  const payloadSize = VERSION_SIZE + batchSaltSize + wrappedSize;
  if(payload.length !== payloadSize) {
    const cause = new BedrockError(
      'Token payload size mismatch.',
      'DataError', {
        public: false,
        actual: payload.length,
        expected: payloadSize
      });
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, cause);
  }

  // parse `salt` and `wrapped` from `payload`
  let offset = payload.byteOffset + VERSION_SIZE;
  const salt = new Uint8Array(payload.buffer, offset, batchSaltSize);
  const wrapped = new Uint8Array(
    payload.buffer, offset += batchSaltSize, wrappedSize);

  // get tokenizer associated with version
  const tokenizer = await tokenizers.get({id: batchVersion.tokenizerId});
  const {hmac} = tokenizer;

  // create KEK via HMAC(version|salt)
  const kek = await _getKek({hmac, version, salt});

  // unwrap `wrapped` as if it were a key
  let unwrapped;
  try {
    unwrapped = await kek.unwrapKey({wrappedKey: wrapped});
    if(unwrapped === null) {
      throw new Error('Decryption failed.');
    }
  } catch(e) {
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, e);
  }

  // at this point, unwrapped is authenticated
  // next, determine if full token is valid

  // parse unwrapped: batchId|index|aad|padding
  offset = unwrapped.byteOffset;
  const batchId = Buffer.from(unwrapped.buffer, offset, batchIdSize);
  const index = unwrapped[batchIdSize];
  // time-safe compare `aad` against given attributes
  const toCompare = new Uint8Array(
    unwrapped.buffer, offset + batchIdSize + 1, attributes.length);
  if(!timingSafeEqual(toCompare, attributes)) {
    // cleartext attributes are not authenticated
    const cause = new BedrockError(
      'Token cleartext attributes are not authenticated.',
      'DataError', {
        public: false
      });
    throw new BedrockError(
      'Invalid token.',
      'DataError', {
        public: true,
        httpStatusCode: 400
      }, cause);
  }

  // token authenticated
  return {batchVersion, tokenizer, batchId, index, attributes};
}

async function _getKek({hmac, version, salt}) {
  // create KEK via HMAC(version|salt)
  const data = new Uint8Array(VERSION_SIZE + salt.length);
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  dv.setUint16(0, version);
  data.set(salt, VERSION_SIZE);
  // use hash signature as `key` for wrapping `toWrap`
  const keyData = await hmac.sign({data});
  return createKek({keyData});
}

function _roundToMultipleOf8(x) {
  return Math.ceil(x / 8) * 8;
}
