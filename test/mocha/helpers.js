const isHmac = hmac => {
  hmac.should.be.an('object');
  hmac.should.have.property('id');
  hmac.id.should.be.a('string');
  hmac.should.have.property('type');
  hmac.type.should.be.a('string');
  hmac.should.have.property('algorithm');
  hmac.should.have.property('capability');
  hmac.should.have.property('invocationSigner');
  hmac.should.have.property('kmsClient');
};

exports.isTokenizer = possibleTokenizer => {
  should.exist(possibleTokenizer);
  possibleTokenizer.should.be.an('object');
  possibleTokenizer.should.have.property('id');
  possibleTokenizer.id.should.be.a('string');
  possibleTokenizer.id.should.include('did:key');
  possibleTokenizer.should.have.property('hmac');
  isHmac(possibleTokenizer.hmac);
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
