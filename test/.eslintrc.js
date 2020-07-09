module.exports = {
  globals: {
    should: true
  },
  env: {
    node: true,
    mocha: true
  },
  extends: [
    'digitalbazaar'
  ],
  ignorePatterns: ['node_modules/']
};
