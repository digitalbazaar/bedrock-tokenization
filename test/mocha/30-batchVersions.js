/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import {cleanDB, insertRecord, isBatchVersion} from './helpers.js';
import {
  mockBatchVersion, mockBatchVersion2, mockBatchVersionOptions,
  mockBatchVersionOptions2
} from './mock.data.js';
import {batchVersions} from '@bedrock/tokenization';
import {tokenizers} from '@bedrock/tokenizer';

describe('BatchVersions', function() {
  let tokenizer = null;
  before(async function() {
    tokenizer = await tokenizers.getCurrent();
  });
  it('should create a BatchVersion', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const id = 0;
    const tokenizerId = 'some-tokenizerId';
    await batchVersions.create({id, tokenizerId, options});
  });
  it('should fail to create a BatchVersion', async function() {
    let err;
    try {
      const options = {batchIdSize: 16, batchSaltSize: 99};
      const id = 0;
      // missing `tokenizerId`
      await batchVersions.create({id, options});
    } catch(e) {
      err = e;
    }
    should.exist(err);
    err.message.should.include('tokenizerId (string) is required');
  });
  it('should ensureBatchVersion when no existing version', async function() {
    const tokenizerId = 'no-existing-version';
    const result = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(result);
  });
  it('should ensureBatchVersion with an existing version', async function() {
    const {id: tokenizerId} = tokenizer;
    const result1 = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(result1);

    const result2 = await batchVersions.ensureBatchVersion({tokenizerId});
    isBatchVersion(result2);
    result1.should.deep.equal(result2);
  });
  it('should test ensureBatchVersion concurrency', async function() {
    const tokenizerId = 'test-concurrency';
    const promises = [];
    for(let i = 0; i < 10; ++i) {
      promises.push(batchVersions.ensureBatchVersion({tokenizerId}));
    }
    let batchId;
    const results = await Promise.all(promises);
    for(const result of results) {
      isBatchVersion(result);
      if(batchId === undefined) {
        batchId = result.batchVersion.id;
      } else {
        batchId.should.equal(result.batchVersion.id);
      }
    }
    batchId.should.be.a('number');
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
      const collections = [
        {
          collectionName: 'tokenization-batchVersion',
          records: [mockBatchVersion, mockBatchVersion2]
        },
        {
          collectionName: 'tokenization-batchVersionOptions',
          records: [mockBatchVersionOptions, mockBatchVersionOptions2]
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
    it(`is properly indexed for 'batchVersion.id' in get()`, async function() {
      const {id} = mockBatchVersion.batchVersion;
      const {executionStats} = await batchVersions.get({id, explain: true});
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage
        .keyPattern.should.eql({'batchVersion.id': 1});
    });
    it(`is properly indexed for 'batchVersion.tokenizerId' in get()`,
      async function() {
        const {tokenizerId} = mockBatchVersion.batchVersion;
        const {executionStats} = await batchVersions.get({
          tokenizerId, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.inputStage
          .keyPattern.should.eql(
            {'batchVersion.tokenizerId': 1, 'batchVersion.id': -1});
      });
    it(`is properly indexed for sort of 'batchVersion.id' in ` +
      '_getLastVersion()', async function() {
      const {executionStats} = await batchVersions._getLastVersion({
        explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('FETCH');
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage.keyPattern
        .should.eql({'batchVersion.id': 1});
    });
    it(`is properly indexed for sort of 'batchVersion.id' in ` +
      '_getLastVersion() when passing `tokenizerId`', async function() {
      const {executionStats} = await batchVersions._getLastVersion({
        tokenizerId: 'foo',
        explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(0);
      executionStats.executionStages.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.keyPattern
        .should.eql({'batchVersion.tokenizerId': 1, 'batchVersion.id': -1});
    });
    it(`is properly indexed for compound query of 'batchVersion.id' and ` +
      `'batchVersion.tokenizerId' in get()`, async function() {
      const {id, tokenizerId} = mockBatchVersion.batchVersion;
      const {executionStats} = await batchVersions.get({
        id, tokenizerId, explain: true
      });
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      // winning query plan could be either {'batchVersion.id': 1} or
      // {'batchVersion.tokenizerId': 1} in this case.
      executionStats.executionStages.inputStage.inputStage.inputStage
        .keyPattern.should.be.deep.oneOf([
          {'batchVersion.id': 1},
          {'batchVersion.tokenizerId': 1, 'batchVersion.id': -1}
        ]);
    });
    it(`is properly indexed for 'batchVersionOptions.id' in setOptions()`,
      async function() {
        const {options} = mockBatchVersionOptions.batchVersionOptions;
        const {executionStats} = await batchVersions.setOptions({
          options, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        let {executionStages: targetStage} = executionStats;
        // only mongodb 8+ has 'EXPRESS_IXSCAN'
        if(targetStage.stage === 'EXPRESS_IXSCAN') {
          targetStage.keyPattern.should.eql(
            '{ batchVersionOptions.id: 1 }');
        } else {
          targetStage = executionStats.executionStages.inputStage.inputStage;
          targetStage.stage.should.equal('IXSCAN');
          targetStage.keyPattern.should.eql(
            {'batchVersionOptions.id': 1});
        }
      });
    it(`is properly indexed for 'batchVersionOptions.id' in getOptions()`,
      async function() {
        const {executionStats} = await batchVersions.getOptions({
          explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        executionStats.executionStages.inputStage.inputStage.inputStage.stage
          .should.equal('IXSCAN');
        executionStats.executionStages.inputStage.inputStage.inputStage
          .keyPattern.should.eql({'batchVersionOptions.id': 1});
      });
  });
});
