const {tokenizers, tokenVersions} = require('bedrock-tokenization');
const {isTokenVersion, cleanDB} = require('./helpers');

describe('TokenVersions', function() {
  let tokenizer = null;
  before(async function() {
    await cleanDB();
    tokenizer = await tokenizers.getCurrent();
  });
  it('should create a TokenVersion with out an id', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const {id: tokenizerId} = tokenizer;
    await tokenVersions.create({tokenizerId, options});
  });
  it('should create a TokenVersion with an id', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const id = 'test-token-version-id';
    await tokenVersions.create({id, options});
  });
  it('should ensureTokenVersion when no existing version', async function() {
    const tokenizerId = 'no-existing-version';
    const result = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(result);
  });
  it('should ensureTokenVersion with an existing version', async function() {
    const {id: tokenizerId} = tokenizer;
    const result = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(result);
  });
  it('should set options for TokenVersion', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const result = await tokenVersions.setOptions({options});
    should.exist(result);
    result.should.be.an('boolean');
    result.should.equal(true);
  });
  it('should get TokenVersion by version id', async function() {
    const {id: tokenizerId} = tokenizer;
    const expectedOptions = {batchIdSize: 16, batchSaltSize: 16};
    await tokenVersions.setOptions({options: expectedOptions});
    const tokenVersion = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(tokenVersion);
    const {tokenVersion: {id}} = tokenVersion;
    const result = await tokenVersions.get({id});
    isTokenVersion(result);
    result.tokenVersion.tokenizerId.should.equal(tokenizerId);
  });
  it('should get TokenVersion by tokenizerId', async function() {
    const {id: tokenizerId} = tokenizer;
    const expectedOptions = {batchIdSize: 16, batchSaltSize: 99};
    await tokenVersions.setOptions({options: expectedOptions});
    const result = await tokenVersions.get({tokenizerId});
    isTokenVersion(result);
    result.tokenVersion.tokenizerId.should.equal(tokenizerId);
  });
  it('should get options', async function() {
    const options = {batchIdSize: 16, batchSaltSize: 99};
    const result = await tokenVersions.getOptions();
    should.exist(result);
    result.should.be.an('object');
    result.should.have.property('meta');
    result.meta.should.be.an('object');
    result.should.have.property('tokenVersionOptions');
    const {tokenVersionOptions} = result;
    tokenVersionOptions.should.be.an('object');
    tokenVersionOptions.should.have.property('id');
    tokenVersionOptions.should.have.property('options');
    tokenVersionOptions.options.should.deep.equal(options);
  });
  it('should insert options', async function() {
    const options = {batchIdSize: 24, batchSaltSize: 31};
    const result = await tokenVersions.insertOptions({options});
    console.log({result});
  });
});
