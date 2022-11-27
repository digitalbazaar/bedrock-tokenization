/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import {cleanDB, insertRecord, isRegistration} from './helpers.js';
import {mockDocument, mockDocument2} from './mock.data.js';
import {Cipher} from '@digitalbazaar/minimal-cipher';
import crypto from 'node:crypto';
import {documents} from '@bedrock/tokenization';
import {tokenizers} from '@bedrock/tokenizer';
import {
  X25519KeyAgreementKey2020
} from '@digitalbazaar/x25519-key-agreement-key-2020';

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

describe('Documents', function() {
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

      const {registration: {jwe}} = await documents.getRegistration({
        internalId
      });
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
        await documents.register({
          externalId,
          document,
          recipients,
          ttl: 30000
        });
      } catch(e) {
        err = e;
      }
      err.message.should.equal('"recipients" must be a non-empty array.');
    });

    it('should error when an empty recipientChain array is passed',
      async () => {
        const recipientChain = [];
        const externalId = 'did:test:failure';
        const document = {example: 'document'};
        let err;
        try {
          await documents.register({
            externalId,
            document,
            recipientChain,
            ttl: 30000
          });
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
        await documents.register({
          externalId,
          document,
          recipientChain,
          ttl: 30000
        });
      } catch(e) {
        err = e;
      }
      err.message.should.equal('"recipients" must be a non-empty array.');
    });

    it('should error when no TTL is passed', async () => {
      const recipients = [
        {header: {kid: key1.id, alg: 'ECDH-ES+A256KW'}}
      ];
      let err;
      try {
        await documents.register({
          externalId: 'did:test:register:with:data',
          document: {},
          recipients
        });
      } catch(e) {
        err = e;
      }
      err.message.should.include('ttl (number) is required');
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

      const decrypted = await cipher.decryptObject({
        jwe, keyAgreementKey: key1
      });
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

  describe('documents._hmacString()', () => {
    let hmac;
    before(async () => {
      ({hmac} = await tokenizers.getCurrent());
    });

    it('should produce a 34 byte Buffer give a small value', async () => {
      let result;
      let error;
      const value = '670dbcb1-164a-4d47-8d54-e3e89f5831f9';
      try {
        result = await documents._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);
      result.should.be.instanceOf(Buffer);
      result.should.have.length(34);
    });

    it('should produce a 34 byte Buffer given a large value', async () => {
      let result;
      let error;
      const value = crypto.randomBytes(4096).toString('hex');
      try {
        result = await documents._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);
      result.should.be.instanceOf(Buffer);
      result.should.have.length(34);
    });

    it('should produce the same output given the same value', async () => {
      let result1;
      let error;
      const value = '294c9caa-707a-4758-ae5c-fe7306c25cc2';
      try {
        result1 = await documents._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      let result2;
      error = undefined;
      try {
        result2 = await documents._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      result1.should.eql(result2);
    });

    it('should produce different output given different values', async () => {
      let result1;
      let error;
      try {
        result1 = await documents._hmacString({
          hmac,
          value: '294c9caa-707a-4758-ae5c-fe7306c25cc2'
        });
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      let result2;
      error = undefined;
      try {
        result2 = await documents._hmacString({
          hmac,
          value: '0e26c923-84e6-4918-9337-f82c56951007'
        });
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      result1.should.not.eql(result2);
    });
  });
});

describe('Documents Database Tests', function() {
  describe('Indexes', function() {
    beforeEach(async () => {
      const collectionName = 'tokenization-registration';
      await cleanDB({collectionName});

      await insertRecord({record: mockDocument, collectionName});
      // second record is inserted here in order to do proper assertions for
      // 'nReturned', 'totalKeysExamined' and 'totalDocsExamined'.
      await insertRecord({record: mockDocument2, collectionName});
    });
    it(`is NOT indexed for 'registration.internalId' in getRegistration()`,
      async function() {
        // Note: an index is not created for `registration.internalId` because
        // queries based on that field alone are rare; they are not run in hot
        // code paths nor do they need to run quickly -- so the index cost is
        // not justified. Therefore, a collection scan should be done.
        const {internalId} = mockDocument.registration;
        const {executionStats} = await documents.getRegistration({
          internalId, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(0);
        executionStats.executionStages.inputStage.stage.should
          .equal('COLLSCAN');
      });
    it('is properly indexed for compound query of ' +
      `'registration.externalIdHash' and 'registration.documentHash' in ` +
      '_getRegistrationRecord()', async function() {
      const {externalIdHash, documentHash} = mockDocument.registration;
      const {executionStats} = await documents._getRegistrationRecord({
        externalIdHash, documentHash, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage
        .keyPattern.should.eql({
          'registration.externalIdHash': 1, 'registration.documentHash': 1
        });
    });
    it('is properly indexed for compound query of ' +
      `'registration.externalIdHash' and 'registration.documentHash' in ` +
      '_refresh()', async function() {
      const {externalIdHash, documentHash} = mockDocument.registration;
      const ttl = 3000;
      const creatorHash = '6efaeca4-10fa-40f2-a5bf-7a3e1314eaf0';
      const {executionStats} = await documents._refresh({
        externalIdHash, documentHash, ttl, creatorHash, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage
        .keyPattern.should.eql({
          'registration.externalIdHash': 1, 'registration.documentHash': 1
        });
    });
  });
});
