/*!
 * Copyright (c) 2020-2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const {
  requireUncached, isBatchVersion, cleanDB, insertRecord
} = require('./helpers');
const {tokenizers} = requireUncached('bedrock-tokenizer');
const {batchVersions} = requireUncached('bedrock-tokenization');
const {mockBatchVersion, mockBatchVersionOptions} = require('./mock.data.js');

describe('BatchVersions', function() {
  let tokenizer = null;
  before(async function() {
    tokenizer = await tokenizers.getCurrent();
  });
  it.skip('should create a BatchVersion with out an id', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const {id: tokenizerId} = tokenizer;
    await batchVersions.create({tokenizerId, options});
  });
  it('should create a BatchVersion with an id', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const id = 0;
    await batchVersions.create({id, options});
  });
  it('should ensureBatchVersion when no existing version', async function() {
    const tokenizerId = 'no-existing-version';
    const result = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(result);
  });
  it('should ensureBatchVersion with an existing version', async function() {
    const {id: tokenizerId} = tokenizer;
    const result = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(result);
  });
  it('should set options for BatchVersion', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const result = await batchVersions.setOptions({options});
    should.exist(result);
    result.should.be.an('boolean');
    result.should.equal(true);
  });
  it('should get BatchVersion by version id', async function() {
    const {id: tokenizerId} = tokenizer;
    const expectedOptions = {batchIdSize: 16, batchSaltSize: 16};
    await batchVersions.setOptions({options: expectedOptions});
    const batchVersion = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(batchVersion);
    const {batchVersion: {id}} = batchVersion;
    const result = await batchVersions.get({id});
    isBatchVersion(result);
    result.batchVersion.tokenizerId.should.equal(tokenizerId);
  });
  it('should get BatchVersion by tokenizerId', async function() {
    const {id: tokenizerId} = tokenizer;
    const expectedOptions = {batchIdSize: 16, batchSaltSize: 99};
    await batchVersions.setOptions({options: expectedOptions});
    const result = await batchVersions.get({tokenizerId});
    isBatchVersion(result);
    result.batchVersion.tokenizerId.should.equal(tokenizerId);
  });
  it('should get options', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const result = await batchVersions.getOptions();
    should.exist(result);
    result.should.be.an('object');
    result.should.have.property('meta');
    result.meta.should.be.an('object');
    result.should.have.property('batchVersionOptions');
    const {batchVersionOptions} = result;
    batchVersionOptions.should.be.an('object');
    batchVersionOptions.should.have.property('id');
    batchVersionOptions.should.have.property('options');
    batchVersionOptions.options.should.deep.equal(options);
  });
  it.skip('should insert options', async function() {
    const options = {batchIdSize: 24, batchSaltSize: 31};
    const result = await batchVersions.insertOptions({options});
    console.log({result});
  });
});

describe('BatchVersions Database Tests', function() {
  describe('Indexes', function() {
    beforeEach(async () => {
      const collectionNames = [
        'tokenization-batchVersion', 'tokenization-batchVersionOptions'
      ];
      for(const collectionName of collectionNames) {
        await cleanDB({collectionName});
      }
    });
    it(`is properly indexed for 'batchVersion.id' in get()`, async function() {
      const collectionName = 'tokenization-batchVersion';
      await insertRecord({record: mockBatchVersion, collectionName});

      const {id} = mockBatchVersion.batchVersion;
      const {executionStats} = await batchVersions.get({id, explain: true});
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
    });
    it(`is properly indexed for 'batchVersion.tokenizerId' in get()`,
      async function() {
        const collectionName = 'tokenization-batchVersion';
        await insertRecord({record: mockBatchVersion, collectionName});

        const {tokenizerId} = mockBatchVersion.batchVersion;
        const {executionStats} = await batchVersions.get({
          tokenizerId, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
      });
    it(`is properly indexed in _getNextVersionId()`, async function() {
      const collectionName = 'tokenization-batchVersion';
      await insertRecord({record: mockBatchVersion, collectionName});

      const {executionStats} = await batchVersions._getNextVersionId({
        explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(0);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
    });
    it(`is properly indexed for compound query of 'batchVersion.id' and ` +
    `'batchVersion.tokenizerId' in get()`, async function() {
      const collectionName = 'tokenization-batchVersion';
      await insertRecord({record: mockBatchVersion, collectionName});

      const {id, tokenizerId} = mockBatchVersion.batchVersion;
      const {executionStats} = await batchVersions.get({
        id, tokenizerId, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
    });
    it(`is properly indexed for 'batchVersionOptions.id' in setOptions()`,
      async function() {
        const collectionName = 'tokenization-batchVersionOptions';
        await insertRecord({record: mockBatchVersionOptions, collectionName});

        const {options} = mockBatchVersionOptions.batchVersionOptions;
        const {executionStats} = await batchVersions.setOptions({
          options, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.stage
          .should.equal('IXSCAN');
      });
    it(`is properly indexed for 'batchVersionOptions.id' in getOptions()`,
      async function() {
        const collectionName = 'tokenization-batchVersionOptions';
        await insertRecord({record: mockBatchVersionOptions, collectionName});

        const {executionStats} = await batchVersions.getOptions({
          explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
      });
  });
});
