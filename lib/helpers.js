/*!
 * Copyright (c) 2020-2026 Digital Bazaar, Inc.
 */
import assert from 'assert-plus';

export const MAX_EXPIRATION_DATE = new Date('9000-01-01T00:00:00Z');

export function assertTtl({ttl} = {}) {
  assert.number(ttl, 'ttl');
  if(ttl <= 0 && ttl !== -1) {
    throw new Error(
      '"ttl" must be a positive number or -1 (indicating the maximum TTL).');
  }
}

export function getExpires({now, ttl} = {}) {
  assertTtl({ttl});
  return ttl === -1 ? MAX_EXPIRATION_DATE : new Date(now + ttl);
}
