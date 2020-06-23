const {requireUncached, areTokens} = require('./helpers');
const {tokens} = requireUncached('bedrock-tokenization');

describe('Tokens', function() {
  it('should create a token with attributes', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const internalId = 'foo';
    const result = await tokens.create({internalId, attributes, tokenCount});
    areTokens(result);
  });
  it('should create a token without attributes', async function() {
    const tokenCount = 5;
    const internalId = 'no-attr';
    const result = await tokens.create({internalId, tokenCount});
    areTokens(result);
  });
});
