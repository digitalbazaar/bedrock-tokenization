const {tokens, tokenizers} = require('bedrock-tokenization');
const {cleanDB} = require('./helpers');

describe('Tokens', function() {
  let tokenizer = null;
  beforeEach(async function() {
    await cleanDB();
    tokenizer = await tokenizers.getCurrent();
  });
  it('should create a token with attributes', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const internalId = 'foo';
    const result = await tokens.create(
      {tokenizer, internalId, attributes, tokenCount});
    console.log('create tokens', result);
  });
  it('should create a token with out attributes', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const internalId = 'foo';
    const result = await tokens.create(
      {tokenizer, internalId, attributes, tokenCount});
    console.log('create tokens', result);
  });
});
