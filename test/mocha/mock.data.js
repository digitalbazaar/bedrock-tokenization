/*!
 * Copyright (c) 2021-2022 Digital Bazaar, Inc. All rights reserved.
 */
export const mockData = {};

// mock product IDs and reverse lookup for webkms/edv/etc service products
mockData.productIdMap = new Map();

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
  mockData.productIdMap.set(product.id, product);
  mockData.productIdMap.set(product.name, product);
}

const now = Date.now();
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);

export const mockDocument = {
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
    expires: tomorrow
  }
};

export const mockDocument2 = {
  meta: {
    created: now,
    updated: now
  },
  registration: {
    internalId: '448de567-5e19-4a54-8b0e-1d0e2128f13d',
    externalIdHash: 'bcface6c-9775-415a-b822-29e1c55a5317',
    documentHash: '67dd35e3-32bb-4176-8b05-30a14ca925d9',
    tokenizerId: 'did:key:z6Mkeo5B5FK7vPf2DCZwvMqP1y46bEb7RMFWDXiUHZ6iFz53',
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

export const mockTokenBatch = {
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
    expires: tomorrow,
    batchInvalidationCount: 0,
    minAssuranceForResolution: 2
  }
};

export const mockTokenBatch2 = {
  meta: {
    created: now,
    updated: now
  },
  tokenBatch: {
    id: '6682e906-8251-4500-87b8-6359ad8af5bc',
    internalId: '7d12a5a3-faa0-4b2b-ae4e-453039c3bf94',
    batchVersion: 0,
    resolvedList: 'ad433952-f48c-4af4-8555-11967c938c01',
    maxTokenCount: 100,
    remainingTokenCount: 99,
    expires: tomorrow,
    batchInvalidationCount: 0,
    minAssuranceForResolution: 2
  }
};

export const mockPairwise = {
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

export const mockPairwise2 = {
  meta: {
    created: now,
    updated: now
  },
  pairwiseToken: {
    internalId: 'aabc85a8-119f-4eca-b853-c8a3eaf0cbe7',
    requester: 'requester',
    value: '7279827a-a20a-4c0b-96d7-dfc5912576fb'
  }
};

export const mockBatchVersion = {
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

export const mockBatchVersion2 = {
  meta: {
    created: now,
    updated: now
  },
  batchVersion: {
    id: 2345,
    tokenizerId: 'did:key:z6Mkeo5B5FK7vPf2DCZwvMqP1y46bEb7RMFWDXiUHZ6iFz53',
    options: {
      batchIdSize: 16,
      batchSaltSize: 16,
      batchTokenCount: 100,
      ttl: 5184000000
    }
  }
};

export const mockBatchVersionOptions = {
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

export const mockBatchVersionOptions2 = {
  meta: {
    created: now,
    updated: now
  },
  batchVersionOptions: {
    id: 'MOCK_OPTIONS',
    options: {
      batchIdSize: 16,
      batchSaltSize: 16,
      batchTokenCount: 100,
      ttl: 5184000000
    }
  }
};

export const mockEntity1 = {
  meta: {
    created: now,
    updated: now
  },
  entity: {
    // internalId is generated in tests.
    batchInvalidationCount: 0,
    openBatch: {
      // openBatch[2] is generated in tests.
    },
    minAssuranceForResolution: 2,
    expires: tomorrow
  }
};

export const mockEntity2 = {
  meta: {
    created: now,
    updated: now
  },
  entity: {
    // internalId is generated in tests.
    batchInvalidationCount: 0,
    openBatch: {},
    minAssuranceForResolution: 2,
    expires: tomorrow
  }
};
