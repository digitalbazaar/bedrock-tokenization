const {requireUncached, areTokens, cleanBatchDB} = require('./helpers');
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
  it('should create a token without internalId', async function() {
    const tokenCount = 2;
    const attributes = Uint8Array.from(new Set([1, 2]));
    const result = await tokens.create({attributes, tokenCount});
    areTokens(result);
  });
  it('should throw error if "attributes" is not uint8Array', async function() {
    const tokenCount = 5;
    const internalId = 'foo';
    const attributesTypes = [1, false, {}, '', []];

    for(const attributes of attributesTypes) {
      let err;
      let result;
      try {
        result = await tokens.create({internalId, attributes, tokenCount});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.message.should.equal('"attributes" must be a Uint8Array.');
    }
  });
  it('should throw error if "attributes" length is greater than max size',
    async function() {
      const tokenCount = 5;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
      let err;
      let result;
      try {
        result = await tokens.create({internalId, attributes, tokenCount});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.message.should.equal('"attributes" maximum size is 8 bytes.');
    });
  // it.only('should throw duplicate error if token is created twice.',
  //   async function() {
  //     const tokenCount = 1;
  //     const attributes = Uint8Array.from(new Set([1]));
  //     const internalId = 'foo';
  //     const requester = 'requester';
  //     const requester1 = 'rerrr';
  //     let err;
  //     let result1;
  //     let result2;
  //     let token;
  //     try {
  //       const {tokens: tks} = await tokens.create(
  //         {internalId, attributes, tokenCount});
  //         token = tks[0];
  //         result1 = await tokens.resolve({requester, token});
  //         console.log(result1);
  //         try {
  //           result2 = await tokens.resolve({requester: requester1, token});
  //         } catch (error) {
  //           console.log(error, '------------>');
  //         }
  //         console.log(result2);
  //     } catch(e) {
  //       err = e;
  //     }
  //     console.log(err, 'this is the err');
  //   });
  it('should throw error if token does not exist in database',
    async function() {
      const tokenCount = 1;
      const attributes = Uint8Array.from(new Set([1]));
      const internalId = 'foo';
      const requester = 'requester';
      let err;
      let result;
      try {
        const {tokens: tks} = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks[0];
        // intentionally clear tokenBatch database to remove token created
        await cleanBatchDB();
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('NotFoundError');
      err.message.should.equal('Token not found.');
    });
  it('should resolve token to the party identified by "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1]));
      const requester = 'requester';
      let err;
      let result;
      let tks;
      try {
        tks = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks.tokens[0];
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(err);
      areTokens(tks);
      should.exist(result.pairwiseToken);
    });
  it('should resolve token when called twice with same "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1]));
      const requester = 'requester';
      let err;
      let result1;
      let result2;
      let tks;
      try {
        tks = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks.tokens[0];
        result1 = await tokens.resolve({requester, token});
        result2 = await tokens.resolve({requester, token});

      } catch(e) {
        err = e;
      }
      should.not.exist(err);
      areTokens(tks);
      should.exist(result1.pairwiseToken);
      should.exist(result2.pairwiseToken);
      result1.pairwiseToken.should.equal(result2.pairwiseToken);
    });
  it('should throw error when token is resolved with different "requester"',
    async function() {
      const tokenCount = 1;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1]));
      const requester1 = 'requester1';
      const requester2 = 'requester2';

      let err;
      let result1;
      let result2;
      let tks;
      try {
        tks = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks.tokens[0];
        result1 = await tokens.resolve({requester: requester1, token});
        result2 = await tokens.resolve({requester: requester2, token});

      } catch(e) {
        err = e;
      }
      should.exist(err);
      areTokens(tks);
      should.exist(result1.pairwiseToken);
      should.not.exist(result2);
      err.name.should.equal('NotAllowedError');
      err.message.should.equal('Token already used.');
    });
  it('should throw error when token is not uint8Array', async function() {
    const tokenCount = 1;
    const internalId = 'foo';
    const attributes = Uint8Array.from(new Set([1]));
    const requester = 'requester';
    let err;
    let result;
    try {
      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      let token = tks[0];
      // change type of token
      token = '';
      result = await tokens.resolve({requester, token});
    } catch(e) {
      err = e;
    }
    should.exist(err);
    should.not.exist(result);
    err.name.should.equal('TypeError');
    err.message.should.equal('"token" must be a Uint8Array that is 2 bytes or' +
      ' more in size.');
  });
  it('should throw error if token length is less than minimumSize',
    async function() {
      const tokenCount = 1;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1, 2, 3]));
      const requester = 'requester';
      let err;
      let result;
      try {
        const {tokens: tks} = await tokens.create(
          {internalId, attributes, tokenCount});
        let token = tks[0];
        // change length of token to be less than 50
        token = token.slice(0, 48);
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
  it('should throw error if token length is greater than maximumSize',
    async function() {
      const tokenCount = 1;
      const internalId = 'foo';
      const attributes = Uint8Array.from(new Set([1, 2, 3]));
      const requester = 'requester';
      let err;
      let result;
      let token;
      try {
        const {tokens: tks} = await tokens.create(
          {internalId, attributes, tokenCount});
        token = tks[0];
        // change length of token to be greater than 58
        token = Uint8Array.from([
          0, 0, 129, 160, 29, 189, 3, 64, 185, 31, 158,
          32, 154, 159, 45, 235, 20, 205, 64, 222, 9,
          66, 192, 79, 183, 54, 204, 169, 197, 19, 52,
          89, 223, 49, 130, 40, 202, 189, 181, 112, 245,
          14, 251, 121, 5, 64, 178, 119, 89, 75, 1, 2, 3,
          4, 5, 10, 200, 300, 10
        ]);
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      token.length.should.equal(59);
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
  it('should resolve token to "internalId" it is linked to', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1]));
    const internalId = 'foo';
    let err;
    let result;
    try {
      const {tokens: tks} = await tokens.create(
        {internalId, attributes, tokenCount});
      const token = tks[0];
      result = await tokens.resolveToInternalId({token});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.should.be.an('object');
    result.should.deep.equal({internalId: 'foo'});
  });
  it('"internalID" should be null if no internalId was provided when creating' +
    ' token', async function() {
    const tokenCount = 5;
    const attributes = Uint8Array.from(new Set([1]));
    let err;
    let result;
    try {
      const {tokens: tks} = await tokens.create(
        {attributes, tokenCount});
      const token = tks[0];
      result = await tokens.resolveToInternalId({token});
    } catch(e) {
      err = e;
    }
    should.not.exist(err);
    should.exist(result);
    result.should.be.an('object');
    result.should.deep.equal({internalId: null});
  });
  it('should throw error when wrapped value fails to get decrypted',
    async function() {
      const tokenCount = 1;
      const attributes = Uint8Array.from(new Set([1]));
      const internalId = 'foo';
      const requester = 'requester';
      let err;
      let result;
      try {
        const {tokens: tks} = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks[0];
        // change first wrapped value to zero
        token[18] = 0;
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
      err.cause.message.should.equal('Decryption failed.');
    });
  it('should throw error when "attributes" is incorrect.',
    async function() {
      const tokenCount = 1;
      const attributes = Uint8Array.from(new Set([1]));
      const internalId = 'foo';
      const requester = 'requester';
      let err;
      let result;
      try {
        const {tokens: tks} = await tokens.create(
          {internalId, attributes, tokenCount});
        const token = tks[0];
        //mess with attribute at index 50
        token[50] = 0;
        result = await tokens.resolve({requester, token});
      } catch(e) {
        err = e;
      }
      should.not.exist(result);
      should.exist(err);
      err.name.should.equal('DataError');
      err.message.should.equal('Invalid token.');
    });
});
