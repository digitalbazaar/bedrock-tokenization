/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */

const MIDDLE_MAP = new Map();
MIDDLE_MAP.set(16, 3);
MIDDLE_MAP.set(32, 4);

// value is a Uint8Array
export function computeIndexFields({fieldName, value}) {
  const rValue = {};

  const MIDDLE = MIDDLE_MAP.get(value.length);

  // first byte is low cardinality
  rValue[`${fieldName}_0`] = value[0];

  // second set of four bytes is high cardinality
  rValue[`${fieldName}_1`] = Buffer.from(value.slice(1, MIDDLE));

  // the remaining bytes, slice end is not inclusive
  rValue[`${fieldName}_2`] = Buffer.from(value.slice(MIDDLE));

  return rValue;
}
