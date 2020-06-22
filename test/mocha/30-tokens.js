const {tokens, tokenizers} = require('bedrock-tokenization');
const {cleanDB} = require('./helpers');

describe('Tokens', function() {
  let tokenizer = null;
  before(async function() {
    await cleanDB();
    tokenizer = await tokenizers.getCurrent();
  });
  it('should create a token', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const internalId = 'foo';
    const result = await tokens.create(
      {tokenizer, internalId, attributes, tokenCount});
    console.log('create tokens', result);
  });
});
