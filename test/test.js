/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
require('bedrock-app-identity');
require('bedrock-express');
require('bedrock-jsonld-document-loader');
require('bedrock-mongodb');
require('bedrock-tokenizer');
require('bedrock-tokenization');
require('bedrock-https-agent');
require('bedrock-kms');
require('bedrock-kms-http');
require('bedrock-meter');
require('bedrock-meter-usage-reporter');
const {handlers} = require('bedrock-meter-http');
require('bedrock-ssm-mongodb');

require('bedrock-test');

const mockData = require('./mocha/mock.data');

bedrock.events.on('bedrock.init', async () => {
  /* Handlers need to be added before `bedrock.start` is called. These are
  no-op handlers to enable meter usage without restriction */
  handlers.setCreateHandler({
    handler({meter} = {}) {
      // use configured meter usage reporter as service ID for tests
      const {service} = mockData.productIdMap.get(meter.product.id);
      meter.serviceId = service.id;
      return {meter};
    }
  });
  handlers.setUpdateHandler({handler: ({meter} = {}) => ({meter})});
  handlers.setRemoveHandler({handler: ({meter} = {}) => ({meter})});
  handlers.setUseHandler({handler: ({meter} = {}) => ({meter})});
});

bedrock.start();
