const {requireUncached, areTokens} = require('./helpers');
const {tokens, tokenizers} = requireUncached('bedrock-tokenization');

describe('Tokens', function() {
  let tokenizer = null;
  beforeEach(async function() {
    tokenizer = await tokenizers.getCurrent();
  });
  it('should create a token with attributes', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const internalId = 'foo';
    const result = await tokens.create(
      {tokenizer, internalId, attributes, tokenCount});
    areTokens(result);
  });
  it('should create a token with out attributes', async function() {
    const tokenCount = 5;
    const internalId = 'no-attr';
    const result = await tokens.create(
      {tokenizer, internalId, tokenCount});
    areTokens(result);
  });
});
