const {requireUncached, isRegistration} = require('./helpers');
const {documents} = requireUncached('bedrock-tokenization');
const {X25519KeyPair} = require('x25519-key-pair');
const {Cipher} = require('minimal-cipher');
const cipher = new Cipher();

// this is test data borrowed from minimal-cipher
const recipients = [
  {
    header: {
      kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoA' +
        'nwWsdvktH#z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
      alg: 'ECDH-ES+A256KW',
    }
  }
];

const key1 = new X25519KeyPair({
  id: 'did:key:z6MkgDEDniwkugeRADbi5CmHFB2eFdFKh6gSCYHFUeHXaV2x' +
    '#z6LScXou54NfzNThVwG1aF85TCuFbVPmKuKspufF7eVmHW7G',
  controller: 'did:key:z6MkgDEDniwkugeRADbi5CmHFB2eFdFKh6gSCYHFUeHXaV2x',
  type: 'X25519KeyAgreementKey2019',
  publicKeyBase58: 'rdjYkZotujxQYtF3bc88cgmkLredJ9iwvwZdBrEa8LW',
  privateKeyBase58: '4HKArAGZaGzwutAEjsbTSjbKDLrQJAP3zLPoZQtHxeuh'
});

const key2 = new X25519KeyPair({
  id: 'did:key:z6MkrefS4sDAGNBdo7CeXKh52sBfK94NGMANfHKfbYpvPz8S' +
    '#z6LScKCBLkDApcTvYPbjQi6EDKgpYwWiM9Ppd6X1PbjXF2dg',
  controller: 'did:key:z6MkrefS4sDAGNBdo7CeXKh52sBfK94NGMANfHKfbYpvPz8S',
  type: 'X25519KeyAgreementKey2019',
  publicKeyBase58: 'e21pSQJj9kBT1Dxt4aGtjULhnybeYDfk7oKu95zXerv',
  privateKeyBase58: 'bcB3uZng7RPz7VSEJSid54cyiU2STGHk4Ub91VEenPP'
});

describe('documents.getRegistration()', () => {
  it('should retrieve a registration for an internalId', async () => {
    const recipients = [
      {header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}}
    ];
    const document = {example: 'document'};
    const externalId = 'did:test:getRegistration';
    const {registration: {jwe: encryptedRegistration, internalId}} =
      await documents.register({
        externalId,
        creator: 'someCreatorId',
        document,
        recipients,
        ttl: 30000
      });

    const {registration: {jwe}} = await documents.getRegistration({internalId});
    jwe.should.eql(encryptedRegistration);
  });
});

describe('documents.register()', () => {
  it('should register a document without creator', async () => {
    const result = await documents.register({
      externalId: 'did:test:register',
      document: {},
      recipients,
      ttl: 30000
    });
    isRegistration(result);
  });

  it('should error when an empty recipients array is passed', async () => {
    const recipients = [];
    const externalId = 'did:test:failure';
    const document = {example: 'document'};
    let err;
    try {
      await documents.register({externalId, document, recipients});
    } catch(e) {
      err = e;
    }
    err.message.should.equal('"recipients" must be a non-empty array.');
  });

  it('should error when an empty recipientChain array is passed', async () => {
    const recipientChain = [];
    const externalId = 'did:test:failure';
    const document = {example: 'document'};
    let err;
    try {
      await documents.register({externalId, document, recipientChain});
    } catch(e) {
      err = e;
    }
    err.message.should.equal('"recipientChain" must be a non-empty array.');
  });

  it('should error when an empty recipientChain item is passed', async () => {
    const recipientChain = [[]];
    const externalId = 'did:test:failure';
    const document = {example: 'document'};
    let err;
    try {
      await documents.register({externalId, document, recipientChain});
    } catch(e) {
      err = e;
    }
    err.message.should.equal('"recipients" must be a non-empty array.');
  });

  it('should register a document with creator', async () => {
    const recipients = [
      {header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}}
    ];
    const result = await documents.register({
      externalId: 'did:test:register:with:data',
      document: {},
      recipients,
      ttl: 30000,
      creator: 'some_creator'
    });
    isRegistration(result);
  });

  it('should delete a document with an expired ttl', async () => {
    const recipients = [
      {header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}}
    ];
    const result = await documents.register({
      externalId: 'did:test:register:with:small:ttl',
      document: {},
      recipients,
      ttl: 1000
    });
    isRegistration(result);
  });
});

describe('documents._encrypt()', () => {
  it('should encrypt a document with recipients', async () => {
    const recipients = [
      {header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}},
      {header: {kid: key2.id, alg: 'ECDH-ES+A256KW'}}
    ];

    const document = {example: 'document'};
    const jwe = await documents._encrypt({document, recipients});

    jwe.recipients.should.be.an('array');
    jwe.recipients.length.should.equal(2);

    const decrypted = await cipher.decryptObject({jwe, keyAgreementKey: key1});
    decrypted.should.have.property('example', 'document');
  });

  it('should encrypt a document with a recipientChain', async () => {
    const recipientChain = [
      // first pass (inner jwe)
      [{header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}}],
      // second pass (outer jwe)
      [{header: {kid: key2.id, alg: 'ECDH-ES+A256KW'}}]
    ];

    const document = {example: 'document'};
    const outerJwe = await documents._encrypt({document, recipientChain});

    outerJwe.recipients.should.be.an('array');
    outerJwe.recipients.length.should.equal(1);

    const innerJwe = await cipher.decryptObject({
      jwe: outerJwe, keyAgreementKey: key2
    });

    innerJwe.recipients.should.be.an('array');
    innerJwe.recipients.length.should.equal(1);

    const decrypted = await cipher.decryptObject({
      jwe: innerJwe, keyAgreementKey: key1
    });

    decrypted.should.have.property('example', 'document');
  });
});
