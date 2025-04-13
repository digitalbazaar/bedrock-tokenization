/*!
 * Copyright (c) 2020-2025 Digital Bazaar, Inc. All rights reserved.
 */
import {cleanDB, insertRecord} from './helpers.js';
import {mockEntity1, mockEntity2, mockEntity3} from './mock.data.js';
import {entities} from '@bedrock/tokenization';
import {IdGenerator} from 'bnid';

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
      let {executionStages: targetStage} = executionStats;
      // only mongodb 8+ has 'EXPRESS_IXSCAN'
      if(targetStage.stage === 'EXPRESS_IXSCAN') {
        targetStage.keyPattern.should.eql(
          '{ entity.internalId: 1 }');
      } else {
        targetStage = executionStats.executionStages.inputStage.inputStage;
        targetStage.stage.should.equal('IXSCAN');
        targetStage.keyPattern.should.eql(
          {'entity.internalId': 1});
      }
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
        let {executionStages: targetStage} = executionStats;
        // only mongodb 8+ has 'EXPRESS_IXSCAN'
        if(targetStage.stage === 'EXPRESS_IXSCAN') {
          targetStage.keyPattern.should.eql(
            '{ entity.internalId: 1 }');
        } else {
          targetStage = executionStats.executionStages.inputStage.inputStage;
          targetStage.stage.should.equal('IXSCAN');
          targetStage.keyPattern.should.eql(
            {'entity.internalId': 1});
        }
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
    it(`is properly indexed for 'entity.internalId' in upsert()`,
      async function() {
        const {internalId} = mockEntity1.entity;
        const ttl = 3000;
        const {executionStats} = await entities._upsert({
          internalId, ttl, minAssuranceForResolution: 2, explain: true
        });
        executionStats.nReturned.should.equal(1);
        executionStats.totalKeysExamined.should.equal(1);
        executionStats.totalDocsExamined.should.equal(1);
        let {executionStages: targetStage} = executionStats;
        // only mongodb 8+ has 'EXPRESS_IXSCAN'
        if(targetStage.stage === 'EXPRESS_IXSCAN') {
          targetStage.keyPattern.should.eql(
            '{ entity.internalId: 1 }');
        } else {
          targetStage = executionStats.executionStages.inputStage.inputStage;
          targetStage.stage.should.equal('IXSCAN');
          targetStage.keyPattern.should.eql(
            {'entity.internalId': 1});
        }
      });
  });
  describe('getCount()', function() {
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
      mockEntity3.entity.internalId = Buffer.from(
        await idGenerator.generate());

      // mutliple records are inserted here in order to do proper assertions
      // for 'nReturned', 'totalKeysExamined' and 'totalDocsExamined'.
      await insertRecord({
        record: mockEntity1, collectionName
      });
      await insertRecord({
        record: mockEntity2, collectionName
      });
      await insertRecord({
        record: mockEntity3, collectionName
      });
    });
    it('should get the total count of entity records in the database.',
      async function() {
        const result = await entities.getCount();
        should.exist(result);
        const {count} = result;
        count.should.be.a('number');
        count.should.equal(3);
      });
    it('should get the total count of entity records that match the query.',
      async function() {
        const query = {'entity.minAssuranceForResolution': 1};
        const result = await entities.getCount({query});
        should.exist(result);
        const {count} = result;
        count.should.be.a('number');
        count.should.equal(1);
      });
  });
});
