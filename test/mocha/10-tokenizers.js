const {tokenizers} = require('bedrock-tokenization');

describe('tokenizers', function() {
  it('should getCurrent tokenizer when none is cached', async function() {
    const tokenizer = await tokenizers.getCurrent();
    console.log({tokenizer});
  });
});
