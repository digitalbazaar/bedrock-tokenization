/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from 'bedrock';
import * as brHttpsAgent from 'bedrock-https-agent';
import {
  AsymmetricKey,
  Hmac,
  Kek,
  KeystoreAgent,
  KeyAgreementKey,
  KmsClient
} from 'webkms-client';
import {TextEncoder} from 'util';

const TEXT_ENCODER = new TextEncoder();

export async function createKeystore({capabilityAgent, referenceId} = {}) {
  const kmsBaseUrl = `${bedrock.config.server.baseUri}/kms`;
  // create keystore
  const config = {
    sequence: 0,
    controller: capabilityAgent.id
  };
  if(referenceId) {
    config.referenceId = referenceId;
  }
  const {httpsAgent} = brHttpsAgent;
  return KmsClient.createKeystore({
    url: `${kmsBaseUrl}/keystores`,
    config,
    httpsAgent
  });
}

export async function getKeystore({id} = {}) {
  const {httpsAgent} = brHttpsAgent;
  return KmsClient.getKeystore({id, httpsAgent});
}

export function getKeystoreAgent({capabilityAgent, keystore} = {}) {
  const {httpsAgent} = brHttpsAgent;
  const kmsClient = new KmsClient({keystore, httpsAgent});
  const keystoreAgent = new KeystoreAgent(
    {keystore, capabilityAgent, kmsClient});
  return keystoreAgent;
}

export async function generateKey(
  {type, invocationSigner, kmsClient, kmsModule} = {}) {
  let Class;
  if(type === 'hmac' || type === 'Sha256HmacKey2019') {
    type = 'Sha256HmacKey2019';
    Class = Hmac;
  } else if(type === 'kek' || type === 'AesKeyWrappingKey2019') {
    type = 'AesKeyWrappingKey2019';
    Class = Kek;
  } else if(type === 'Ed25519VerificationKey2018') {
    type = 'Ed25519VerificationKey2018';
    Class = AsymmetricKey;
  } else if(type === 'keyAgreement' || type === 'X25519KeyAgreementKey2019') {
    type = 'X25519KeyAgreementKey2019';
    Class = KeyAgreementKey;
  } else {
    throw new Error(`Unknown key type "${type}".`);
  }

  const keyDescription = await kmsClient.generateKey(
    {kmsModule, type, invocationSigner});
  const {id: newId} = keyDescription;
  return new Class(
    {id: newId, type, invocationSigner, kmsClient, keyDescription});
}

export async function hmacString({hmac, value}) {
  const data = TEXT_ENCODER.encode(value);
  const signature = await hmac.sign({data});
  // TODO: worth using hmac type to add prefix to signature for future proofing?
  // ... `sha256:<signature>`? ... note that this could complicate key rotation
  return signature;
}
