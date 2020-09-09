/*!
 * Copyright (c) 2020 Digital Bazaar, Inc. All rights reserved.
 */

// value is a Uint8Array
export function computeIndexFields({fieldName, value}) {
  const rValue = {};

  // first byte is low cardinality
  rValue[`${fieldName}_0`] = Buffer.from(value.slice(0, 1));

  // second set of four bytes is high cardinality
  rValue[`${fieldName}_1`] = Buffer.from(value.slice(1, 5));

  // the remaining bytes, slice end is not inclusive
  rValue[`${fieldName}_2`] = Buffer.from(value.slice(5));

  return rValue;
}
