const database = require('bedrock-mongodb');

exports.isDocument = result => {
  console.log('isDocument', {result});
};

exports.isTokenVersion = (possibleTokenVersion, expectedOptions) => {
  should.exist(possibleTokenVersion);
  possibleTokenVersion.should.be.an('object');
  possibleTokenVersion.should.have.property('meta');
  possibleTokenVersion.meta.should.be.an('object');
  possibleTokenVersion.should.have.property('tokenVersion');
  const {tokenVersion} = possibleTokenVersion;
  tokenVersion.should.be.an('object');
  tokenVersion.should.have.property('id');
  tokenVersion.id.should.be.a('number');
  tokenVersion.should.have.property('tokenizerId');
  tokenVersion.tokenizerId.should.be.a('string');
  tokenVersion.should.have.property('options');
  tokenVersion.options.should.be.an('object');
  if(expectedOptions) {
    tokenVersion.options.should.deep.equal(expectedOptions);
  }
};

exports.cleanDB = async () => {
  await database.collections['tokenizer-tokenizer'].deleteMany({});
  await database.collections['tokenization-document'].deleteMany({});
  await database.collections['tokenization-pairwiseToken'].deleteMany({});
  await database.collections['tokenization-tokenVersion'].deleteMany({});
  await database.collections['tokenization-tokenVersionOptions'].deleteMany({});
  await database.collections['tokenization-tokenBatch'].deleteMany({});
};

exports.cleanBatchDB = async () => {
  await database.collections['tokenization-tokenBatch'].deleteMany({});
};

exports.areTokens = result => {
  should.exist(result);
  result.should.be.an('object');
  result.should.have.property('tokens');
  const {tokens} = result;
  tokens.should.be.an('array');
  tokens.forEach(token => {
    should.exist(token);
    token.should.be.an('Uint8Array');
  });
};

// we need to reset the module for most tests
exports.requireUncached = module => {
  delete require.cache[require.resolve(module)];
  return require(module);
};
