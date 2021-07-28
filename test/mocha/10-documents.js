const {requireUncached, isRegistration} = require('./helpers');
const {documents} = requireUncached('bedrock-tokenization');
const {X25519KeyAgreementKey2020} =
  require('@digitalbazaar/x25519-key-agreement-key-2020');
const {Cipher} = require('@digitalbazaar/minimal-cipher');
const cipher = new Cipher();

// this is test data borrowed from minimal-cipher
const key1 = new X25519KeyAgreementKey2020({
  id: 'did:key:z6MkwLz9d2sa3FJjni9A7rXmicf9NN3e5xgJPUmdqaFMTgoE#' +
    'z6LSmgLugoC8vUoK1ouCTGKdqFdpg5jb3H193L6wFJucX14U',
  controller: 'did:key:z6MkwLz9d2sa3FJjni9A7rXmicf9NN3e5xgJPUmdqaFMTgoE',
  type: 'X25519KeyAgreementKey2020',
  publicKeyMultibase: 'z6LSmgLugoC8vUoK1ouCTGKdqFdpg5jb3H193L6wFJucX14U',
  privateKeyMultibase: 'z3wedGgRfySXFenmev8caU3eqBeDXrzDsdi21ofMZN8s8Exm'
});
const key2 = new X25519KeyAgreementKey2020({
  id: 'did:key:z6MkttYcTAeZbVsBiAmxFj2LNSgNzj5gAdb3hbE4QwmFTK4Z#' +
    'z6LSjPQz1GARHBL7vnMW8XiH3UYVkgETpyk8oKhXeeFRGpQh',
  controller: 'did:key:z6MkttYcTAeZbVsBiAmxFj2LNSgNzj5gAdb3hbE4QwmFTK4Z',
  type: 'X25519KeyAgreementKey2020',
  publicKeyMultibase: 'z6LSjPQz1GARHBL7vnMW8XiH3UYVkgETpyk8oKhXeeFRGpQh',
  privateKeyMultibase: 'z3web9AUP49zFCBVEdQ4ksbSmzgi6JqNCA84XNxUAcMDZgZc'
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
    const recipients = [{
      header: {
        kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH#' +
          'z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
        alg: 'ECDH-ES+A256KW',
      }
    }];
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
