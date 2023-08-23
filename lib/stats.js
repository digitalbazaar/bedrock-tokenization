/*!
 * Copyright (c) 2023 Digital Bazaar, Inc. All rights reserved.
 */
import * as database from '@bedrock/mongodb';
import dayjs from 'dayjs';

/**
 * Retrieves statistics from the database within a specified date range or
 * for a specific date up to the end of the current date.
 *
 * @param {object} options - Options hashmap.
 * @param {string} options.startDate - The start date of the range which is an
 *   ISO 8601 date string in the "YYYY-MM-DD" format.
 * @param {string} [options.endDate] - An optional end date of the range which
 *   is an ISO 8601 date string in the "YYYY-MM-DD" format. If an end date is
 *   not provided, the timestamp that corresponds to the end of the day
 *   specified by Date.now() will be used as the end date.
 *
 * @returns {Promise<object>} Resolves with an object containing statistical
 *   data.
 */
export async function get({startDate, endDate} = {}) {
  if(!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  const startTimestamp = dayjs(startDate, 'YYYY-MM-DD', true).valueOf();
  const endTimestamp = dayjs(endDate, 'YYYY-MM-DD', true)
    .endOf('day').valueOf();
  const query = {};
  query['meta.created'] = {$gte: startTimestamp, $lte: endTimestamp};
  const collection = database.collections['tokenization-entity'];
  const entitiesCount = await collection.find(query).count();
  const stats = {
    entities: {
      count: entitiesCount
    }
  };
  return stats;
}
