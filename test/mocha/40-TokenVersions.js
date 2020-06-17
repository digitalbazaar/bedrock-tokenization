const {tokenizers, tokenVersions} = require('bedrock-tokenization');
const {isTokenVersion} = require('./helpers');

describe('TokenVersions', function() {
  let tokenizer = null;
  before(async function() {
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
    const tokenizerId = 'test-tokenizer-id';
    const tokenVersion = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(tokenVersion);
  });
  it('should ensureTokenVersion with an existing version', async function() {
    const {id: tokenizerId} = tokenizer;
    const tokenVersion = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(tokenVersion);
  });
  it('should get TokenVersion by version id', async function() {
    const tokenizerId = 'test-tokenizer-id';
    const tokenVersion = await tokenVersions.ensureTokenVersion({tokenizerId});
    isTokenVersion(tokenVersion);
  });
  it('should get TokenVersion by tokenizerId', async function() {

  });
  it('should set options for TokenVersion', async function() {

  });
  it('should get options for TokenVersion', async function() {

  });
  it('should insert options for TokenVersion', async function() {

  });
});
