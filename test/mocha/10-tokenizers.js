const {tokenizers} = require('bedrock-tokenization');
const {isTokenizer} = require('./helpers');

describe('Tokenizers', function() {
  it('should getCurrent tokenizer when none is cached', async function() {
    const tokenizer = await tokenizers.getCurrent();
    isTokenizer(tokenizer);
  });
  it('should get same tokenizer when one is cached', async function() {
    const tokenizer = await tokenizers.getCurrent();
    isTokenizer(tokenizer);
    const cachedTokenizer = await tokenizers.getCurrent();
    isTokenizer(cachedTokenizer);
    tokenizer.should.deep.equal(cachedTokenizer);
  });
  it('should get tokenizer by id', async function() {
    const tokenizer = await tokenizers.getCurrent();
    isTokenizer(tokenizer);
    const {id} = tokenizer;
    const databaseTokenizer = await tokenizers.get({id});
    isTokenizer(databaseTokenizer);
    tokenizer.id.should.equal(databaseTokenizer.id);
    const {hmac} = tokenizer;
    hmac.id.should.equal(databaseTokenizer.hmac.id);
    hmac.type.should.equal(databaseTokenizer.hmac.type);
    hmac.algorithm.should.equal(databaseTokenizer.hmac.algorithm);
    hmac.invocationSigner.id.should.equal(
      databaseTokenizer.hmac.invocationSigner.id);
    hmac.kmsClient.keystore.should.equal(
      databaseTokenizer.hmac.kmsClient.keystore);
  });
});
