/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
const {getAppIdentity} = require('bedrock-app-identity');
require('bedrock-express');
require('bedrock-jsonld-document-loader');
require('bedrock-mongodb');
require('bedrock-tokenizer');
require('bedrock-tokenization');
require('bedrock-https-agent');
require('bedrock-kms');
require('bedrock-kms-http');
const {meters} = require('bedrock-meter');
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

bedrock.events.on('bedrock.ready', async () => {
  const id = 'zV2wZh7G61vwMPk2PVuSC1L';
  const {id: controller} = getAppIdentity();
  const product = mockData.productIdMap.get('Example KMS');
  const meter = {
    id,
    controller,
    product: {id: product.id}
  };
  // manually add service id because we are bypassing the handlers in HTTP API
  meter.serviceId = product.service.id;
  await meters.insert({meter});
  const meterId = `${bedrock.config.server.baseUri}/meters/${id}`;
  bedrock.config.tokenizer.kms.meterId = meterId;
});

bedrock.start();
