/*!
 * Copyright (c) 2020-2022 Digital Bazaar, Inc. All rights reserved.
 */
import * as bedrock from '@bedrock/core';
import {handlers} from '@bedrock/meter-http';
import '@bedrock/https-agent';
import '@bedrock/kms';
import '@bedrock/kms-http';
import '@bedrock/meter';
import '@bedrock/meter-usage-reporter';
import '@bedrock/tokenizer';
import '@bedrock/tokenization';
import '@bedrock/security-context';
import '@bedrock/ssm-mongodb';
import '@bedrock/test';

import {mockData} from './mocha/mock.data.js';

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
