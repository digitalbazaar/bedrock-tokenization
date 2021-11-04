/*!
 * Copyright (c) 2021 Digital Bazaar, Inc. All rights reserved.
 */
'use strict';

const data = {};

// mock product IDs and reverse lookup for webkms/edv/etc service products
data.productIdMap = new Map();

const products = [{
  // Use default webkms dev `id` and `serviceId`
  id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a29',
  name: 'Example KMS',
  service: {
    // default dev `id` configured in `bedrock-kms-http`
    id: 'did:key:z6MkwZ7AXrDpuVi5duY2qvVSx1tBkGmVnmRjDvvwzoVnAzC4',
    type: 'webkms',
  }
}];

for(const product of products) {
  data.productIdMap.set(product.id, product);
  data.productIdMap.set(product.name, product);
}

const now = Date.now();
const mockDocument = {
  meta: {
    created: now,
    updated: now
  },
  registration: {
    internalId: '43f14128-3b42-11ec-8d3d-0242ac130003',
    externalIdHash: '48c41734-3b42-11ec-8d3d-0242ac130003',
    documentHash: '503daff2-3b42-11ec-8d3d-0242ac130003',
    tokenizerId: 'did:key:z6MkugLpCsat2iV8Xb3Y9kwUf3bMFFexXr4jUbs75grMkofo',
    jwe: {
      protected: 'eyJlbmMiOiJYQzIwUCJ9',
      recipients: ['060ae942-2494-483f-a104-ac345ee6a39d'],
      iv: 'DzkPhy3BVsuEzS-mZunwvorO2rWpov8h',
      ciphertext: `4hPSBaWQ-X5n_78nVOx4b1X4XGiAsOBF0AZDmdWUuLj4c0IslBWMWmtb0bx
        A-6EU4YQg3j3XK-7JZ-5oiiNAVOqHrqj-f9VuJTcLUR0UWdbAe82rCTCJJhZCZG8BsrVhf
        opWYqE3VizpxxJyD7ho-z-4`,
      tag: 'XpQYDgltbuFoRQTQWN6Nlw'
    },
    expires: new Date(now + 3000)
  }
};

const mockTokenBatch = {
  meta: {
    created: now,
    updated: now
  },
  tokenBatch: {
    id: '7ce79b0c-3b52-11ec-8d3d-0242ac130003',
    internalId: '8389ca52-3b52-11ec-8d3d-0242ac130003',
    batchVersion: 0,
    resolvedList: '8a64e5e6-3b52-11ec-8d3d-0242ac130003',
    maxTokenCount: 100,
    remainingTokenCount: 99,
    expires: new Date(now + 3000),
    batchInvalidationCount: 0,
    minAssuranceForResolution: 2
  }
};

const mockPairwise = {
  meta: {
    created: now,
    updated: now
  },
  pairwiseToken: {
    internalId: '669c71a8-3beb-11ec-8d3d-0242ac130003',
    requester: 'requester',
    value: '7063f03a-3beb-11ec-8d3d-0242ac130003'
  }
};

const mockBatchVersion = {
  meta: {
    created: now,
    updated: now
  },
  batchVersion: {
    id: 1234,
    tokenizerId: 'did:key:z6MknCLT249QPKfJZQqDJpQhhMPeHWiBUnYRNHfzfm37G6UK',
    options: {
      batchIdSize: 16,
      batchSaltSize: 16,
      batchTokenCount: 100,
      ttl: 5184000000
    }
  }
};

const mockBatchVersionOptions = {
  meta: {
    created: now,
    updated: now
  },
  batchVersionOptions: {
    id: 'NEXT_OPTIONS',
    options: {
      batchIdSize: 16,
      batchSaltSize: 16,
      batchTokenCount: 100,
      ttl: 5184000000
    }
  }
};

module.exports = {
  data,
  mockDocument,
  mockTokenBatch,
  mockPairwise,
  mockBatchVersion,
  mockBatchVersionOptions
};
