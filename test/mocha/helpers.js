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
