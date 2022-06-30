/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import {areTokens, cleanDB, getTokenBatch, insertRecord} from './helpers.js';
import {documents, entities, tokens} from '@bedrock/tokenization';
import {
  mockEntity1, mockEntity2,
  mockPairwise, mockPairwise2,
  mockTokenBatch, mockTokenBatch2
} from './mock.data.js';
import canonicalize from 'canonicalize';
import crypto from 'node:crypto';
import sinon from 'sinon';

import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {encode} = require('base58-universal');
const {IdGenerator} = require('bnid');

const MAX_UINT32 = 4294967295;

describe('Tokens', function() {
  it('should create a token with attributes', async function() {
    const tokenCount = 5;
    const attributes = new Uint8Array([1, 2]);
    const internalId = await documents._generateInternalId();
    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});
    const result = await tokens.create({internalId, attributes, tokenCount});
    areTokens(result);
  });
  it('should create a token without attributes', async function() {
    const tokenCount = 5;
    const internalId = await documents._generateInternalId();
    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});
    const result = await tokens.create({internalId, tokenCount});
    areTokens(result);
  });
  it('should create a full batch of tokens', async function() {
    const tokenCount = 100;
    const internalId = await documents._generateInternalId();
    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});
    const result = await tokens.create({internalId, tokenCount});
    areTokens(result);
  });
  it('should throw error if internalId is not given', async function() {
    const tokenCount = 2;
    const attributes = new Uint8Array([1, 2]);
    let err;
    let result;
    try {
      result = await tokens.create({attributes, tokenCount});
    } catch(e) {
      err = e;
    }
    should.not.exist(result);
    should.exist(err);
    err.message.should.equal('internalId (buffer) is required');
  });
  it('should throw error if internalId.length does not equal INTERNAL_ID_SIZE',
    async function() {
      const tokenCount = 2;
      const attributes = new Uint8Array([1, 2]);
      const internalIds = [
        Buffer.from([1]),
        Buffer.concat([await documents._generateInternalId(), Buffer.from([1])])
      ];
      for(const internalId of internalIds) {
        let err;
        let result;
        try {
          result = await tokens.create({internalId, attributes, tokenCount});
        } catch(e) {
          err = e;
        }
        should.not.exist(result);
        should.exist(err);
        err.name.should.equal('RangeError');
        err.message.should.equal('"internalId.length" must be 16.');
      }
    });
  it('should create token successfully with dynamically created internalId',
    async function() {
      const dateOfBirth = '1990-05-01';
      const expires = '2021-05-01';
      const identifier = 'T65851254';
      const issuer = 'VA';
      const type = 'DriversLicense';
      const recipients = [
        {
          header: {
            kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoA' +
              'nwWsdvktH#z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
            alg: 'ECDH-ES+A256KW',
          }
        }
      ];
      const tokenCount = 1;
      // canonicalize object then hash it then base58 encode it
      const externalId = encode(crypto.createHash('sha256')
        .update(canonicalize({dateOfBirth, identifier, issuer}))
        .digest());

      const registrationRecord = await documents.register({
        externalId,
        document: {dateOfBirth, expires, identifier, issuer, type},
        recipients,
        ttl: 1209600000
      });

      const {internalId} = registrationRecord.registration;
      let tokenResult;
      let err;
      try {
        tokenResult = await tokens.create({internalId, tokenCount});
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      should.exist(tokenResult);
    }
  );
  it('should throw error if attributes is not uint8Array', async function() {
    const tokenCount = 5;
    const internalId = await documents._generateInternalId();
    const attributesTypes = [1, false, {}, '', []];

    for(const attributes of attributesTypes) {
      let err;
      let result;
      try {
        result = await tokens.create({internalId, attributes, tokenCount});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.message.should.equal('"attributes" must be a Uint8Array.');
    }
  });
  it('should throw error if token does not exist in database',
    async function() {
      const tokenCount = 1;
      const attributes = new Uint8Array([1]);
      const internalId = await documents._generateInternalId();
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks[0];
      // intentionally clear tokenBatch database to remove token created
      const collectionName = 'tokenization-tokenBatch';
      await cleanDB({collectionName});
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('NotFoundError');
      err.message.should.equal('Token not found.');
    });
  it('should resolve token to the party identified by "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const tks = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks.tokens[0];
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      areTokens(tks);
      should.exist(result.pairwiseToken);
    });
  it('should resolve token when called twice with same "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester = 'requester';
      let err;
      let result2;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const tks = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks.tokens[0];
      const result1 = await tokens.resolve({requester, token});
      try {
        // resolve token with same requester again
        result2 = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      areTokens(tks);
      should.exist(result1.pairwiseToken);
      should.exist(result2.pairwiseToken);
      result1.pairwiseToken.should.eql(result2.pairwiseToken);
      result2.internalId.should.eql(internalId);
    });
  it('should not resolve unpinned token when called twice with same ' +
    '"requester" if level of assurance is too low', async function() {
    const tokenCount = 1;
    const internalId = await documents._generateInternalId();
    const attributes = new Uint8Array([1]);
    const requester = 'requester';
    let err;
    let result2;

    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});

    const tks = await tokens.create(
      {internalId, attributes, tokenCount, minAssuranceForResolution: -1});
    const token = tks.tokens[0];
    // should succeed, level of assurance of `2` is high enough
    const result1 = await tokens.resolve(
      {requester, token, levelOfAssurance: 2});
    try {
      // resolve token with same requester again, but insufficient
      // level of assurance
      result2 = await tokens.resolve(
        {requester, token, levelOfAssurance: 1});
    } catch(e) {
      err = e;
    }
    should.exist(err);
    err.name.should.equal('NotAllowedError');
    err.message.should.include(
      'Could not resolve token; minimum level of assurance not met.');

    // now ensure same pairwise token is resolved when LOA is high enough
    result2 = await tokens.resolve(
      {requester, token, levelOfAssurance: 2});
    should.exist(result2);
    areTokens(tks);
    should.exist(result1.pairwiseToken);
    should.exist(result2.pairwiseToken);
    result1.pairwiseToken.should.eql(result2.pairwiseToken);
    result2.internalId.should.eql(internalId);
  });
  it('should throw error when token is resolved with different "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester1 = 'requester1';
      const requester2 = 'requester2';
      let err;
      let result2;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const tks = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks.tokens[0];
      const result1 = await tokens.resolve({requester: requester1, token});
      try {
        // resolve token with different requester
        result2 = await tokens.resolve({requester: requester2, token});
      } catch(e) {
        err = e;
      }
      should.exist(err);
      areTokens(tks);
      should.exist(result1.pairwiseToken);
      should.not.exist(result2);
      err.name.should.equal('NotAllowedError');
      err.message.should.equal('Token already used.');
    });
  it('should not resolve invalid resolved token', async function() {
    const tokenCount = 1;
    const internalId = await documents._generateInternalId();
    const attributes = new Uint8Array([1]);
    const requester = 'requester';
    let err;
    let result2;

    // upsert mock entity the token is for
    const {entity} = await entities._upsert({
      internalId, ttl: 60000, minAssuranceForResolution: -1
    });

    const tks = await tokens.create({
      internalId, attributes, tokenCount, minAssuranceForResolution: -1
    });

    const token = tks.tokens[0];
    await tokens.resolve({requester, token});
    // invalidate token
    const invalidateResult = await tokens.invalidateTokenBatches({entity});
    invalidateResult.should.equal(true);
    try {
      // resolve token with same requester again
      result2 = await tokens.resolve({requester, token});
    } catch(e) {
      err = e;
    }
    should.not.exist(result2);
    err.name.should.equal('NotAllowedError');
    err.message.should.equal('Token has been invalidated.');
  });
  it('should return invalid resolved token with allowResolvedInvalidatedTokens',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester = 'requester';
      let err;
      let result2;

      // upsert mock entity the token is for
      const {entity} = await entities._upsert({
        internalId, ttl: 60000, minAssuranceForResolution: -1
      });

      const tks = await tokens.create({
        internalId, attributes, tokenCount, minAssuranceForResolution: -1
      });

      const token = tks.tokens[0];
      const result1 = await tokens.resolve({requester, token});
      // invalidate tokens
      const invalidateResult = await tokens.invalidateTokenBatches({entity});
      invalidateResult.should.equal(true);
      try {
        // resolve token with same requester again
        result2 = await tokens.resolve({
          requester, token, allowResolvedInvalidatedTokens: true
        });
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      areTokens(tks);
      should.exist(result1.pairwiseToken);
      should.exist(result2.pairwiseToken);
      result1.pairwiseToken.should.eql(result2.pairwiseToken);
      result2.internalId.should.eql(internalId);
    });
  it('should throw error when tokenCount is greater than 100 or less than 0',
    async function() {
      const tokenCounts = [0, 101];
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      for(const tokenCount of tokenCounts) {
        let err;
        let tks;
        try {
          tks = await tokens.create(
            {internalId, attributes, tokenCount});
        } catch(e) {
          err = e;
        }
        should.not.exist(tks);
        should.exist(err);
        err.name.should.equal('RangeError');
        err.message.should.equal('"tokenCount" must be greater than 0 or ' +
          'less than or equal to 100.');
      }
    });
  it('should throw error when token is not uint8Array', async function() {
    const tokenCount = 1;
    const internalId = await documents._generateInternalId();
    const attributes = new Uint8Array([1]);
    const requester = 'requester';
    let err;
    let result;

    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});

    const {tokens: tks} = await tokens.create(
      {internalId, attributes, tokenCount});
    let token = tks[0];
    // change type of token to string
    token = '';
    try {
      result = await tokens.resolve({requester, token});
    } catch(e) {
      err = e;
    }
    should.exist(err);
    should.not.exist(result);
    err.name.should.equal('TypeError');
    err.message.should.equal('"token" must be a Uint8Array that is 2 bytes or' +
      ' more in size.');
  });
  it('should throw error if token length is less than minimumSize',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1, 2, 3]);
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      let token = tks[0];
      // change length of token to be less than 50
      token = token.slice(0, 48);
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
  it('should throw error if token length is greater than maximumSize',
    async function() {
      const tokenCount = 1;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1, 2, 3]);
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      let token;
      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      token = tks[0];
      // change length of token to be greater than 58
      token = new Uint8Array([
        0, 0, 129, 160, 29, 189, 3, 64, 185, 31, 158,
        32, 154, 159, 45, 235, 20, 205, 64, 222, 9,
        66, 192, 79, 183, 54, 204, 169, 197, 19, 52,
        89, 223, 49, 130, 40, 202, 189, 181, 112, 245,
        14, 251, 121, 5, 64, 178, 119, 89, 75, 1, 2, 3,
        4, 5, 10, 200, 300, 10
      ]);
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      token.length.should.equal(59);
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
  it('should resolve token to "internalId" it is linked to', async function() {
    const tokenCount = 5;
    const attributes = new Uint8Array([1]);
    const internalId = await documents._generateInternalId();
    let err;
    let result;

    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});

    const {tokens: tks} = await tokens.create(
      {internalId, attributes, tokenCount});
    const token = tks[0];
    try {
      result = await tokens.resolveToInternalId({token});
    } catch(e) {
      err = e;
    }
    assertNoError(err);
    should.exist(result);
    result.should.be.an('object');
    result.should.eql({internalId});
  });
  it('should throw error when wrapped value fails to get decrypted',
    async function() {
      const tokenCount = 1;
      const attributes = new Uint8Array([1]);
      const internalId = await documents._generateInternalId();
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks[0];
      // change wrapped value by incrementing its first index
      token[65] = (token[65] + 1) & 0xFF;
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
      err.cause.message.should.equal('Decryption failed.');
    });
  it('should throw error when attributes are incorrect.',
    async function() {
      const tokenCount = 1;
      const attributes = new Uint8Array([1]);
      const internalId = await documents._generateInternalId();
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks[0];
      // change attributes value by altering its index at 50
      token[50] = 0;
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
  it('should register and create token concurrently', async function() {
    const dateOfBirth = '2000-05-01';
    const expires = '2021-05-01';
    const identifier = 'T99991234';
    const issuer = 'VA';
    const type = 'DriversLicense';
    const recipients = [
      {
        header: {
          kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoA' +
            'nwWsdvktH#z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
          alg: 'ECDH-ES+A256KW',
        }
      }
    ];
    const tokenCount = 1;
    // canonicalize object then hash it then base58 encode it
    const externalId = encode(crypto.createHash('sha256')
      .update(canonicalize({dateOfBirth, identifier, issuer}))
      .digest());

    let tokenResult;
    let err;
    try {
      tokenResult = await tokens.registerDocumentAndCreate({
        registerOptions: {
          externalId,
          document: {dateOfBirth, expires, identifier, issuer, type},
          recipients,
          ttl: 1209600000
        },
        tokenCount
      });
    } catch(e) {
      err = e;
    }
    assertNoError(err);
    should.exist(tokenResult);
  });
  it('should register duplicate and create token concurrently',
    async function() {
      const dateOfBirth = '2000-05-01';
      const expires = '2021-05-01';
      const identifier = 'T99991234';
      const issuer = 'VA';
      const type = 'DriversLicense';
      const recipients = [
        {
          header: {
            kid: 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoA' +
              'nwWsdvktH#z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc',
            alg: 'ECDH-ES+A256KW',
          }
        }
      ];
      const tokenCount = 1;
      // canonicalize object then hash it then base58 encode it
      const externalId = encode(crypto.createHash('sha256')
        .update(canonicalize({dateOfBirth, identifier, issuer}))
        .digest());

      let tokenResult;
      let err;
      try {
        tokenResult = await tokens.registerDocumentAndCreate({
          registerOptions: {
            externalId,
            document: {dateOfBirth, expires, identifier, issuer, type},
            recipients,
            ttl: 1209600000
          },
          tokenCount
        });
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      should.exist(tokenResult);
    });
  it('should not resolve token from invalidated batch',
    async function() {
      // create tokens
      const tokenCount = 10;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester = 'requester';
      let err;
      let result;

      // upsert mock entity the token is for
      const {entity} = await entities._upsert({internalId, ttl: 60000});

      const tks = await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});
      areTokens(tks);
      const token = tks.tokens[0];
      // invalidate tokens
      const invalidateResult = await tokens.invalidateTokenBatches(
        {entity});
      invalidateResult.should.equal(true);
      try {
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      err.name.should.equal('NotAllowedError');
      err.message.should.equal('Token has been invalidated.');
    });
  it('batchInvalidationCount should not be null',
    async function() {
      // create tokens
      const tokenCount = 10;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});
      const tks = await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});
      areTokens(tks);
      let err;
      let result;
      try {
        result = await getTokenBatch({internalId});
      } catch(e) {
        err = e;
      }
      should.not.exist(err);
      result.tokenBatch.batchInvalidationCount.should.not.equal(null);
      result.tokenBatch.batchInvalidationCount.should.equal(0);
    });
});

describe('TokensDuplicateError', function() {
  let randomBytesStub;
  before(() => {
    randomBytesStub = sinon.stub(crypto, 'randomBytes').callsFake(
      (size, cb) => {
        if(size > MAX_UINT32) {
          throw new RangeError('requested too many random bytes');
        }
        // allocate a zero filled buffer which is returned without further
        // modification
        const bytes = Buffer.alloc(size);
        if(typeof cb === 'function') {
          return process.nextTick(function() {
            cb(null, bytes);
          });
        }
        return bytes;
      });
  });
  after(() => {
    randomBytesStub.restore();
  });
  it('should throw duplicate error if token is created twice.',
    async function() {
      // crypto.randomBytes has been stubbed so that the same batch ID will be
      // generated everytime, and we are consuming all tokens in the first batch
      // associated with the internalId so that when a new batch is created, the
      // same ID is generated and the error occurs.
      const tokenCount = 100;
      const attributes = new Uint8Array([1]);
      const internalId = await documents._generateInternalId();
      let err;
      let result2;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const result1 = await tokens.create({internalId, attributes, tokenCount});
      try {
        // create token again with same parameters
        result2 = await tokens.create({internalId, attributes, tokenCount});
      } catch(e) {
        err = e;
      }
      should.exist(result1);
      should.not.exist(result2);
      should.exist(err);
      err.name.should.equal('DuplicateError');
      err.message.should.equal('Duplicate token batch.');
    });
});

describe('Tokens Database Tests', function() {
  describe('Indexes', function() {
    beforeEach(async () => {
      const collections = [
        {
          collectionName: 'tokenization-tokenBatch',
          records: [mockTokenBatch, mockTokenBatch2]
        },
        {
          collectionName: 'tokenization-pairwiseToken',
          records: [mockPairwise, mockPairwise2]
        }
      ];
      for(const collection of collections) {
        const {collectionName} = collection;
        await cleanDB({collectionName});

        for(const record of collection.records) {
          // mutliple records are inserted here in order to do proper assertions
          // for 'nReturned', 'totalKeysExamined' and 'totalDocsExamined'.
          await insertRecord({
            record, collectionName
          });
        }
      }
    });
    it(`is properly indexed for 'tokenBatch.id in _getBatch()`,
      async function() {
        const {id} = mockTokenBatch.tokenBatch;
        const {executionStats} = await tokens._getBatch({id, explain: true});
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.inputStage
          .keyPattern.should.eql({'tokenBatch.id': 1});
      });
    it(`is properly indexed for compound query of 'tokenBatch.id' and ` +
      `'tokenBatch.resolvedList' in _updateTokenBatch()`, async function() {
      const {id, resolvedList} = mockTokenBatch.tokenBatch;
      const batchId = id;
      const compressed = resolvedList;
      const {executionStats} = await tokens._updateTokenBatch({
        batchId, compressed, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage.should
        .equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'tokenBatch.id': 1});
    });
    it(`is properly indexed for compound query of 'tokenBatch.id', ` +
      `'tokenBatch.internalId' and 'tokenBatch.remainingTokenCount' in ` +
      '_claimTokens()', async function() {
      const {tokenBatch} = mockTokenBatch;
      const {executionStats} = await tokens._claimTokens({
        tokenBatch, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage.should
        .equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'tokenBatch.id': 1});
    });
    it(`is properly indexed for compound query of 'pairwiseToken.internalId' ` +
      `and 'pairwiseToken.requester' in _getPairwiseToken()`, async function() {
      const {internalId, requester} = mockPairwise.pairwiseToken;
      const {executionStats} = await tokens._getPairwiseToken({
        internalId, requester, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage.keyPattern
        .should.eql({
          'pairwiseToken.internalId': 1, 'pairwiseToken.requester': 1
        });
    });
  });
});

describe('Entities Database Tests', function() {
  describe('Indexes', function() {
    beforeEach(async () => {
      const collectionName = 'tokenization-entity';
      await cleanDB({collectionName});

      const idGenerator = new IdGenerator();
      mockEntity1.entity.internalId = Buffer.from(
        await idGenerator.generate());
      mockEntity1.entity.openBatch[2] = Buffer.from(
        await idGenerator.generate());
      mockEntity2.entity.internalId = Buffer.from(
        await idGenerator.generate());

      // mutliple records are inserted here in order to do proper assertions
      // for 'nReturned', 'totalKeysExamined' and 'totalDocsExamined'.
      await insertRecord({
        record: mockEntity1, collectionName
      });
      await insertRecord({
        record: mockEntity2, collectionName
      });
    });
    it(`is properly indexed for 'entity.internalId' in get()`,
      async function() {
        const {internalId} = mockEntity1.entity;
        const {executionStats} = await entities.get({
          internalId, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.inputStage
          .keyPattern.should.eql({'entity.internalId': 1});
      });
    it(`is properly indexed for 'entity.internalId' in ` +
      'setMinAssuranceForResolution()', async function() {
      const {internalId} = mockEntity1.entity;
      const minAssuranceForResolution = 1;
      const {executionStats} = await entities.setMinAssuranceForResolution({
        internalId, minAssuranceForResolution, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'entity.internalId': 1});
    });
    it(`is properly indexed for 'entity.internalId' and` +
      `'entity.batchInvalidationCount' in ` +
      '_incrementBatchInvalidationCount()', async function() {
      const {entity} = mockEntity1;
      const {executionStats} = await entities
        ._incrementBatchInvalidationCount({entity, explain: true});
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'entity.internalId': 1});
    });
    it(`is properly indexed for 'entity.internalId' in _remove()`,
      async function() {
        const {internalId} = mockEntity1.entity;
        const {executionStats} = await entities._remove({
          internalId, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.keyPattern
          .should.eql({'entity.internalId': 1});
      });
    it(`is properly indexed for 'entity.internalId' and ` +
      `'entity.batchInvalidationCount' in ` +
      '_setOpenTokenBatchId()', async function() {
      const {internalId} = mockEntity1.entity;
      const batchId = Buffer.from('558fa903-f0b5-4d1c-9d4c-035bfb0d81f9');
      const batchInvalidationCount = 0;
      const {executionStats} = await entities._setOpenTokenBatchId({
        internalId, batchId, batchInvalidationCount, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'entity.internalId': 1});
    });
    it(`is properly indexed for 'entity.internalId' and ` +
      `'entity.openBatch.{minAssuranceForResolution}' in ` +
      '_setOpenTokenBatchId()', async function() {
      const {internalId, openBatch} = mockEntity1.entity;
      const oldBatchId = openBatch[2];
      const batchId = Buffer.from('558fa903-f0b5-4d1c-9d4c-035bfb0d81f9');
      const batchInvalidationCount = 0;
      const {executionStats} = await entities._setOpenTokenBatchId({
        internalId, batchId, oldBatchId, batchInvalidationCount,
        minAssuranceForResolution: 2, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'entity.internalId': 1});
    });
    it(`is properly indexed for 'entity.internalId' in _upsert()`,
      async function() {
        const {internalId} = mockEntity1.entity;
        const ttl = 3000;
        const {executionStats} = await entities._upsert({
          internalId, ttl, minAssuranceForResolution: 2, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.keyPattern
          .should.eql({'entity.internalId': 1});
      });
  });
});
