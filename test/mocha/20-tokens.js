/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import {areTokens, cleanDB, getTokenBatch, insertRecord} from './helpers.js';
import {documents, entities, tokens} from '@bedrock/tokenization';
import {
  mockPairwise, mockPairwise2,
  mockTokenBatch, mockTokenBatch2
} from './mock.data.js';
import canonicalize from 'canonicalize';
import crypto from 'node:crypto';
import {encode} from 'base58-universal';
import sinon from 'sinon';

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
      tokenResult.should.include.keys(['tokens', 'validUntil']);
      tokenResult.validUntil.should.be.a('Date');
    }
  );
  it('should create token concurrently with registration',
    async function() {
      const dateOfBirth = '1990-05-01';
      const expires = '2021-05-01';
      const identifier = 'T65851255';
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

      let result;
      let err;
      try {
        result = await tokens.registerDocumentAndCreate({
          registerOptions: {
            externalId,
            document: {dateOfBirth, expires, identifier, issuer, type},
            recipients,
            ttl: 60000
          },
          tokenCount
        });
      } catch(e) {
        err = e;
      }
      assertNoError(err);
      should.exist(result);
      result.should.include.keys(
        ['registrationRecord', 'tokens', 'validUntil']);
      result.validUntil.should.be.a('Date');

      // registration record expiration should the same as the token batch
      const {registrationRecord} = result;
      const {registration: {internalId, expires: expiry}} = registrationRecord;
      const {tokenBatch} = await getTokenBatch({internalId});
      // these times could be off by milliseconds, but not minutes
      const diff = Math.abs(tokenBatch.expires.getTime() - expiry.getTime());
      diff.should.be.lessThan(60000);
    }
  );
  it('should extend expiration periods with new token batches',
    async function() {
      const dateOfBirth = '1990-05-01';
      const expires = '2021-05-01';
      const identifier = 'T65851256';
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
      const tokenCount = 99;
      // canonicalize object then hash it then base58 encode it
      const externalId = encode(crypto.createHash('sha256')
        .update(canonicalize({dateOfBirth, identifier, issuer}))
        .digest());

      const registrationRecord = await documents.register({
        externalId,
        document: {dateOfBirth, expires, identifier, issuer, type},
        recipients,
        ttl: 60000
      });

      const {internalId} = registrationRecord.registration;
      await tokens.create({internalId, tokenCount});

      // entity should have `externalIdHash` that matches registered doc
      const {entity} = await entities.get({internalId});
      should.exist(entity.externalIdHash);
      entity.externalIdHash.should.deep.equal(
        registrationRecord.registration.externalIdHash);

      // entity's expiration should equal the new token batch
      const {tokenBatch} = await getTokenBatch({internalId});
      entity.expires.should.deep.equal(tokenBatch.expires);

      const registrationRecord2 = await documents.getRegistration({internalId});
      registrationRecord2.registration.expires.should.deep.equal(
        tokenBatch.expires);

      // creating a new batch should extend the expiration period on the
      // entity and the registration records after waiting a bit
      await new Promise(r => setTimeout(r, 10));
      await tokens.create({internalId, tokenCount});

      const {entity: entity2} = await entities.get({internalId});

      // entity's expiration should equal the new token batch
      const {tokenBatch: tokenBatch2} = await getTokenBatch({
        batchId: entity2.openBatch['2']});
      entity2.expires.should.deep.equal(tokenBatch2.expires);

      // expires should be greater than `entity2.expires`
      entity2.expires.should.be.greaterThan(entity.expires);

      const registrationRecord3 = await documents.getRegistration({internalId});
      registrationRecord3.registration.expires.should.deep.equal(
        tokenBatch2.expires);
      registrationRecord3.registration.expires.should.be.greaterThan(
        registrationRecord2.registration.expires);
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
  it('should resolve token when pairwise token has expired w/same "requester"',
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

      // forcibly expire pairwise token
      const expires = new Date(Date.now() - 1000);
      const updated = await _updatePairwiseToken(
        {internalId, requester, expires});
      updated.should.equal(true);

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
  it('should resolve token to same pairwise token after pairwise expiry',
    async function() {
      const tokenCount = 2;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      const requester = 'requester';
      let err;
      let result2;

      // upsert mock entity the token is for
      await entities._upsert({internalId, ttl: 60000});

      const tks = await tokens.create(
        {internalId, attributes, tokenCount});
      const [token1, token2] = tks.tokens;

      // resolve first token
      const result1 = await tokens.resolve({requester, token: token1});

      // forcibly expire pairwise token
      const expires = new Date(Date.now() - 1000);
      const updated = await _updatePairwiseToken(
        {internalId, requester, expires});
      updated.should.equal(true);

      try {
        // resolve second token with same requester again
        result2 = await tokens.resolve({requester, token: token2});
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

    // entity's `lastAssuranceFailedBatchId` should match the token
    const {tokenBatch: {id: batchId}} = await getTokenBatch({internalId});
    const {entity} = await entities.get({internalId});
    should.exist(entity.lastAssuranceFailedTokenResolution);
    entity.lastAssuranceFailedTokenResolution.batchId
      .should.deep.equal(batchId);
    entity.lastAssuranceFailedTokenResolution.batchInvalidationCount
      .should.deep.equal(0);
    entity.lastAssuranceFailedTokenResolution.date.should.be.a('Date');

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
  it('should resolve token to "entity" it is linked to', async function() {
    const tokenCount = 5;
    const attributes = new Uint8Array([1]);
    const internalId = await documents._generateInternalId();
    let err;
    let result;
    let internalIdResult;

    // upsert mock entity the token is for
    await entities._upsert({internalId, ttl: 60000});

    const {tokens: tks} = await tokens.create(
      {internalId, attributes, tokenCount});
    const token = tks[0];
    try {
      result = await tokens.resolveToEntity({token});
      internalIdResult = await tokens.resolveToInternalId({token});
    } catch(e) {
      err = e;
    }
    assertNoError(err);
    should.exist(result);
    result.should.be.an('object');
    result.should.include.keys(['entity', 'meta']);
    result.entity.should.be.an('object');
    result.entity.internalId.should.eql(internalId);
    result.entity.internalId.should.eql(internalIdResult.internalId);
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
    tokenResult.should.include.keys(['tokens', 'validUntil']);
    tokenResult.validUntil.should.be.a('Date');
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
      tokenResult.should.include.keys(['tokens', 'validUntil']);
      tokenResult.validUntil.should.be.a('Date');
    });
  it('should register expired duplicate and create token concurrently',
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

      let registrationRecord;
      {
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
        tokenResult.should.include.keys(['tokens', 'validUntil']);
        tokenResult.validUntil.should.be.a('Date');
        ({registrationRecord} = tokenResult);
      }

      // now mark registration record expired and register again w/ success
      const {registration} = registrationRecord;
      const collection = database.collections['tokenization-registration'];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const updateResult = await collection.updateOne({
        'registration.externalIdHash': registration.externalIdHash,
        'registration.documentHash': registration.documentHash
      }, {
        $set: {'registration.expires': yesterday}
      });
      updateResult.result.nModified.should.equal(1);

      // now re-registration should update expired registration record
      {
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
        tokenResult.should.include.keys(['tokens', 'validUntil']);
        tokenResult.validUntil.should.be.a('Date');
        tokenResult.registrationRecord.registration.externalIdHash.should
          .deep.equal(registrationRecord.registration.externalIdHash);
        tokenResult.registrationRecord.registration.documentHash.should
          .deep.equal(registrationRecord.registration.documentHash);
        tokenResult.registrationRecord.registration.expires.should.not.equal(
          yesterday);
      }
    });
  it('should register and upsert a pairwise token', async function() {
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
    // canonicalize object then hash it then base58 encode it
    const externalId = encode(crypto.createHash('sha256')
      .update(canonicalize({dateOfBirth, identifier, issuer}))
      .digest());

    const {registration: {internalId}} = await documents.register({
      externalId,
      document: {dateOfBirth, expires, identifier, issuer, type},
      recipients,
      ttl: 1209600000
    });

    const requester = 'requester';
    let record;
    let err;
    try {
      record = await tokens.upsertPairwiseToken({internalId, requester});
    } catch(e) {
      err = e;
    }
    assertNoError(err);
    should.exist(record);
    record.should.include.keys(['meta', 'pairwiseToken']);
    record.pairwiseToken.value.should.be.a('Uint8Array');
  });
  it('should resolve pairwise token when enabled by configuration',
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
      // canonicalize object then hash it then base58 encode it
      const externalId = encode(crypto.createHash('sha256')
        .update(canonicalize({dateOfBirth, identifier, issuer}))
        .digest());

      const {registration: {internalId}} = await documents.register({
        externalId,
        document: {dateOfBirth, expires, identifier, issuer, type},
        recipients,
        ttl: 1209600000
      });

      bedrock.config.tokenization.ensurePairwiseTokenValueIndex.should.be.true;

      const requester = 'requester';
      const record = await tokens.upsertPairwiseToken({internalId, requester});
      should.exist(record);
      record.should.include.keys(['meta', 'pairwiseToken']);
      record.pairwiseToken.value.should.be.a('Uint8Array');

      const {internalId: internalId2} = await tokens.resolvePairwiseToken({
        pairwiseToken: record.pairwiseToken.value
      });

      should.exist(internalId2);
      internalId2.should.deep.equal(internalId);
    });
  it('should not resolve pairwise token when not enabled by configuration',
    async function() {
      const previousConfigValue = bedrock.config.tokenization
        .ensurePairwiseTokenValueIndex;
      bedrock.config.tokenization.ensurePairwiseTokenValueIndex = false;
      try {
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
        // canonicalize object then hash it then base58 encode it
        const externalId = encode(crypto.createHash('sha256')
          .update(canonicalize({dateOfBirth, identifier, issuer}))
          .digest());

        const {registration: {internalId}} = await documents.register({
          externalId,
          document: {dateOfBirth, expires, identifier, issuer, type},
          recipients,
          ttl: 1209600000
        });

        const requester = 'requester';
        const record = await tokens.upsertPairwiseToken({
          internalId, requester
        });
        should.exist(record);
        record.should.include.keys(['meta', 'pairwiseToken']);
        record.pairwiseToken.value.should.be.a('Uint8Array');

        let err;
        try {
          await tokens.resolvePairwiseToken({
            pairwiseToken: record.pairwiseToken.value
          });
        } catch(e) {
          err = e;
        }
        should.exist(err);
        err.name.should.equal('NotAllowedError');
        err.message.should.include(
          'Queries by pairwise token value are not allowed because the ' +
          'pairwise token value index is not enabled.');
      } finally {
        bedrock.config.tokenization.ensurePairwiseTokenValueIndex =
          previousConfigValue;
      }
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
  it('should not resolve invalidated token to "entity"', async function() {
    // create tokens
    const tokenCount = 10;
    const internalId = await documents._generateInternalId();
    const attributes = new Uint8Array([1]);
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
      result = await tokens.resolveToEntity({token});
    } catch(e) {
      err = e;
    }
    should.not.exist(result);
    err.name.should.equal('NotAllowedError');
    err.message.should.equal('Token has been invalidated.');
  });
  it('should resolve invalidated token to "entity"', async function() {
    // create tokens
    const tokenCount = 10;
    const internalId = await documents._generateInternalId();
    const attributes = new Uint8Array([1]);
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
      result = await tokens.resolveToEntity({token});
    } catch(e) {
      err = e;
    }
    should.not.exist(result);
    err.name.should.equal('NotAllowedError');
    err.message.should.equal('Token has been invalidated.');

    err = undefined;
    try {
      result = await tokens.resolveToEntity(
        {token, allowInvalidatedTokens: true});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.should.be.an('object');
    result.should.include.keys(['entity', 'meta']);
    result.entity.should.be.an('object');
    result.entity.internalId.should.eql(internalId);
  });
  it('should not `setMinAssuranceForResolution` after batch invalidation',
    async function() {
      // create tokens
      const tokenCount = 10;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);

      // upsert mock entity the token is for
      let {entity} = await entities._upsert({internalId, ttl: 60000});

      // setting `setMinAssuranceForResolution` should fail because no
      // token has failed to be resolved yet due to low level of assurance
      let result = await entities.setMinAssuranceForResolution({
        entity, minAssuranceForResolution: 1
      });
      result.should.equal(false);

      // setting `setMinAssuranceForResolution` should succeed because
      // we aren't checking for assurance-failed token resolution
      result = await entities.setMinAssuranceForResolution({
        entity, minAssuranceForResolution: 3,
        requireAssuranceFailedTokenResolution: false
      });
      result.should.equal(true);

      // create tokens
      const tks = await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});
      ({entity} = await entities.get({internalId}));

      // now an attempt to `setMinAssuranceForResolution` should fail because
      // no token has assurance-failed resolution yet
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 2});
      result.should.equal(false);
      result = undefined;

      // now resolve a token with an assurance failure
      let err;
      try {
        const requester = 'request-test';
        const token = tks.tokens[0];
        await tokens.resolve({requester, token, levelOfAssurance: 1});
      } catch(e) {
        err = e;
      }
      should.exist(err);
      err.name.should.equal('NotAllowedError');
      err.message.should.include(
        'Could not resolve token; minimum level of assurance not met.');

      // now an attempt to `setMinAssuranceForResolution` should succeed
      // because of an assertion-failed token resolution
      ({entity} = await entities.get({internalId}));
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 1});
      result.should.equal(true);

      // now a simulated attempt to `setMinAssuranceForResolution` should
      // fail because of a simulated last batch invalidation date at the
      // current time
      entity.lastBatchInvalidationDate = new Date();
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 2});
      result.should.equal(false);
      result = undefined;
      delete entity.lastBatchInvalidationDate;

      // now a simulated attempt to `setMinAssuranceForResolution` should
      // fail because of a simulated increased `batchInvalidationCount` set
      // in the `entity` record used
      entity.batchInvalidationCount++;
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 2});
      result.should.equal(false);
      result = undefined;
      entity.batchInvalidationCount--;

      // invalidate tokens (and do not update `entity` afterwards before next
      // `setMinAssuranceForResolution` call to simulate concurrent change)
      ({entity} = await entities.get({internalId}));
      await tokens.invalidateTokenBatches({entity});

      // now an attempt to `setMinAssuranceForResolution` should fail because
      // of a new `batchInvalidationCount` in the database (differs from the
      // entity record)
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 2});
      result.should.equal(false);
      result = undefined;

      // now an attempt to `setMinAssuranceForResolution` should *still* fail
      // because of a new `batchInvalidationCount` in the database, even
      // though the entity's `batchInvalidationCount` has been updated
      ({entity} = await entities.get({internalId}));
      result = await entities.setMinAssuranceForResolution(
        {entity, minAssuranceForResolution: 2});
      result.should.equal(false);
    });
  it(
    'should not `setMinAssuranceForResolution` after batch invalidation ' +
    'without requiring an assurance failed token resolution',
    async function() {
      // create tokens
      const tokenCount = 10;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);

      // upsert mock entity the token is for
      let {entity} = await entities._upsert({internalId, ttl: 60000});

      // setting `setMinAssuranceForResolution` should succeed
      let result = await entities.setMinAssuranceForResolution({
        entity, minAssuranceForResolution: 1,
        requireAssuranceFailedTokenResolution: false
      });
      result.should.equal(true);

      // create and then invalidate tokens
      await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});
      ({entity} = await entities.get({internalId}));
      await tokens.invalidateTokenBatches({entity});

      // now an attempt to `setMinAssuranceForResolution` should fail because
      // of a new `batchInvalidationCount`
      result = await entities.setMinAssuranceForResolution({
        entity, minAssuranceForResolution: 2,
        requireAssuranceFailedTokenResolution: false
      });
      result.should.equal(false);
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
  it('should ensure `updateEntityWithNoValidTokenBatches` checks batches',
    async function() {
      // create tokens
      const tokenCount = 10;
      const internalId = await documents._generateInternalId();
      const attributes = new Uint8Array([1]);
      // upsert mock entity the token is for
      let {entity} = await entities._upsert({
        // init `minAssuranceForResolution` to allow it to be set to `2` below
        internalId, ttl: 60000, minAssuranceForResolution: 1
      });

      // update entity `minAssuranceForResolution` should succeed because there
      // is no unpinned token batch
      let updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(true);

      // create an unpinned token batch
      await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});

      await entities._upsert({
        // set `minAssuranceForResolution` to allow it to be set to `2` below
        internalId, ttl: 60000, minAssuranceForResolution: 1
      });
      ({entity} = await entities.get({internalId}));

      // update entity `minAssuranceForResolution` should fail because a valid
      // unpinned token batch exists
      updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(false);

      // invalidate token batches and refresh entity record
      await tokens.invalidateTokenBatches({entity});
      ({entity} = await entities.get({internalId}));

      // update entity `minAssuranceForResolution` should now succeed because
      // there are no valid open unpinned token batches
      updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(true);

      // create new unpinned token batches
      await tokens.create(
        {internalId, attributes, tokenCount, minAssuranceForResolution: -1});

      // set `minAssuranceForResolution` back to `1` and refresh entity record
      await entities._upsert({
        internalId, ttl: 60000, minAssuranceForResolution: 1
      });
      ({entity} = await entities.get({internalId}));

      // update entity `minAssuranceForResolution` should fail because a valid
      // unpinned token batch exists
      updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(false);

      // manually delete token batch
      const collection = database.collections['tokenization-tokenBatch'];
      await collection.deleteMany({});

      // update entity `minAssuranceForResolution` should now succeed because
      // there are no valid open unpinned token batches
      updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(true);
    });
  it(
    'should ensure `updateEntityWithNoValidTokenBatches` throws on entity ' +
    'state change', async function() {
      const internalId = await documents._generateInternalId();
      // upsert mock entity the token is for
      const {entity} = await entities._upsert({
        // init `minAssuranceForResolution` to allow it to be set to `2` below
        internalId, ttl: 60000, minAssuranceForResolution: 1
      });

      // update entity `minAssuranceForResolution` should throw because the
      // entity record `minAssuranceForResolution` does not match
      entity.minAssuranceForResolution = 5;
      let err;
      try {
        await tokens.updateEntityWithNoValidTokenBatches(
          {entity, minAssuranceForResolution: 2});
      } catch(e) {
        err = e;
      }
      should.exist(err);
      err.name.should.equal('InvalidStateError');
      entity.minAssuranceForResolution = 1;

      // update entity `minAssuranceForResolution` should now succeed because
      // there are no valid open unpinned token batches
      const updated = await tokens.updateEntityWithNoValidTokenBatches(
        {entity, minAssuranceForResolution: 2});
      updated.should.equal(true);
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
      `'tokenBatch.resolvedList' in _updateBatch()`, async function() {
      const {id, resolvedList} = mockTokenBatch.tokenBatch;
      const batchId = id;
      const compressed = resolvedList;
      const {executionStats} = await tokens._updateBatch({
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
      const {executionStats} = await tokens.getPairwiseToken({
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

async function _updatePairwiseToken({internalId, requester, expires}) {
  const query = {
    'pairwiseToken.internalId': internalId,
    'pairwiseToken.requester': requester
  };
  const update = {
    $set: {
      'meta.updated': Date.now(),
      'pairwiseToken.expires': expires
    }
  };

  // return `true` if the update occurred
  const collection = database.collections['tokenization-pairwiseToken'];
  const result = await collection.updateOne(query, update);
  return result.result.n !== 0;
}
