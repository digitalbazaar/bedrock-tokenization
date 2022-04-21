module.exports = {
  globals: {
    should: true,
    assertNoError: true
  },
  env: {
    node: true,
    mocha: true
  },
  parserOptions: {
    // this is required for dynamic import()
    ecmaVersion: 2020
  },
  extends: [
    'digitalbazaar'
  ],
  ignorePatterns: ['node_modules/']
};
