const {tokenizers} = require('bedrock-tokenization');
const {isTokenizer} = require('./helpers');

describe('tokenizers', function() {
  it('should getCurrent tokenizer when none is cached', async function() {
    const tokenizer = await tokenizers.getCurrent();
    isTokenizer(tokenizer);
  });
});
