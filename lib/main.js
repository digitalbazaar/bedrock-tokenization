/*!
 * Copyright (c) 2020-2021 Digital Bazaar, Inc. All rights reserved.
 */
import './config.js';

import * as documents from './documents.js';
import * as tokens from './tokens.js';
import * as batchVersions from './batchVersions.js';

export {documents, tokens, batchVersions};

/**
 * Attempts to lower the `minAssuranceForResolution` on the given registration
 * and any token batches associated with it. This function may only be called
 * on a registration that has a `minAssuranceForResolution` that is greater
 * than or equal to the pass `minAssuranceForResolution`.
 *
 * If another process updates the registration before it can be updated by the
 * current process, then a conflict error will be thrown.
 *
 * @param {object} options - Options to use.
 * @param {object} options.registration - The registration to update.
 * @param {number} options.minAssuranceForResolution - The new minimum level of
 *   assurance required for token resolution.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
async function lowerMinAssuranceForResolution({
  registration, minAssuranceForResolution
} = {}) {
  if(minAssuranceForResolution > registration.minAssuranceForResolution) {
    throw new Error(
      'Invalid API usage; minAssuranceForResolution ' +
      `(${minAssuranceForResolution}) must be less than or equal to ` +
      'registration.minAssuranceForResolution ' +
      `(${registration.minAssuranceForResolution}).`);
  }

  /*

  To register, upsert openTokenBatch w/expires matching
  document registration expires

  To lower `minAssuranceForResolution`:

  Update



  */

  /* This function lowers the `minAssuranceForResolution` on the given
  registration and any related token batches. The code and this exposition
  presumes that changes will only be made if the registration's current
  `minAssuranceForResolution` is greater than or equal to the passed value.
  It relies on the `registration` record as an atomic gate for this; if it
  has changed when this process tries to update it, then a conflict error will
  be raised. If these assumptions change, then the following exposition will
  also need to change to consider additional possible states.

  The `minAssuranceForResolution` constraint is set in multiple places that may
  safely get out of sync with one another. It must appear in more than one
  place due to architectural, security, and privacy requirements (e.g.,
  indexing, sharding, confidentiality of token/registration information) that
  enable hot code paths to execute quickly.

  One place is on a registration and the other is on the token batches for the
  `internalId` associated with that registration. To lower
  `minAssuranceForResolution`, first the registration is updated and then every
  token batch is updated.

  Since the above operation is neither wholly atomic nor isolated, we must
  consider what will happen if it is partially executed or if a concurrent
  process modifies the same state.

  There are two calls to consider:

  1. Updating the registration.
  2. Updating the token batches.

  The first call is internally atomic -- and if it fails, the second call
  will not be executed (this is the simplest case and it is not considered
  below). The second call is not entirely internally atomic; each individual
  token batch update is but updating all of them (if there is more than one)
  is not.

  Therefore, we have the following cases to consider in order to explain
  how an acceptable state will always be reached after the first call
  is successfully executed:

  1. We never execute the second call (e.g., we crash before calling it).
  2. Another process changes the registration's constraint to another
    value while we make the second call.
  3. Another process changes some token batch constraints to another
    value while we make the second call.
  4. The second call results in only a partial update (e.g., we crash
    during the call) or a read occurs on a token batch that has not yet
    been updated during the call.

  Case 1: We never execute the second call.

  The registration will be marked as having a lower constraint but any
  token batches will maintain whatever their current value was. So, what
  will happen if someone tries to resolve those tokens?

  If a token from a token batch with a higher constraint is used, then token
  resolution will fail and require additional identity assurance to be provided
  and a potential need to call this function to lower
  `minAssuranceForResolution` again. This is considered acceptable as it causes
  us to simply repeat the action we were trying to do before.

  If a token instead has a lower constraint, then the token will resolve. We
  presume that having a token in this state is valid, i.e., that it arrived at
  this state through some previous valid operation and this state is therefore
  also not an issue.

  Case 2: Another process changes the registration's constraint to another
    value while we make the second call.

  Here we may mark some token batches with a constraint that is different
  from the registration's new constraint. If the value we're setting is lower
  than the new one, this means that our update could replace a newly set higher
  value with a lower one, enabling the batch to be used to resolve a token even
  though a more recent update to the registration intended to prevent this from
  happening. This is not an acceptable outcome.

  In order to address this case, we must ensure, when raising the constraint
  that all token batches created prior to setting the constraint on the
  registration are invalidated. Since a new token batch could be created while
  the registration itself is being updated, we must update the registration's
  constraint first and we cannot rely on a current matching constraint value
  from the registration as an indication that the token batches have been made
  consistent -- as we may crash prior to invalidating token batches marked
  with a lower constraint.

  We must also consider that, while raising the registration constraint,
  another process may be in line to lower it again. This other process
  may create token batches with a lower constraint that our process goes on
  to erroneously mark as invalid. In order to prevent this from happening, we
  use a sequence update number on the registration record that is copied to the
  token batches. This enables us to keep track of which registration record
  instance was considered when the token batch was created. This enables the
  invalidate process to only consider token batches that were created prior to
  the registration record update, avoiding invalidating new token batches.

  This sequence number is also used to avoid changes to the constraint that are
  out of sequence, causing a conflict error to be thrown instead of making an
  out of order change. This eliminates the case where another process makes
  a change concurrently with our own; it can only be the case that the other
  process is a *subsequent* update -- and its changes should take precedence
  over our own.

  Case 3: Another process changes some token batch constraints to another
    value while we make the second call.

  If the other process is lowering the constraint further, than there are
  no significant differences from Case 1. We may mark a token batch with
  a higher constraint thus triggering a need to lower the constraint again.

  If the other process is raising the constraint, then as long as we limit
  our updates to token batches that have a sequence number that is less
  than the new one for the registration, we will not update any new token
  batches with an erroneously low constraint. If the sequence number increases
  on the registration for a reason other than an update to the constraint,
  then we will again fall into Case 1.

  Case 4: The second call results in only a partial update (e.g., we crash
    during the call) or a read occurs on a token batch that has not yet
    been updated during the call.

  Any token batches that are read with a different constraint value will be
  treated just as in Case 1. */

  // lower minAssuranceForResolution on registration and token batches
  const {sequence, documentHash, externalIdHash, internalId} = registration;
  await documents._setMinAssuranceForResolution({
    sequence, externalIdHash, documentHash, minAssuranceForResolution
  });
  await tokens._setMinAssuranceForResolution({
    internalId, minAssuranceForResolution
  });
}

/**
 * Attempts to raise the `minAssuranceForResolution` on the given registration
 * and any token batches associated with it. This function may only be called
 * on a registration that has a `minAssuranceForResolution` that is less
 * than or equal to the pass `minAssuranceForResolution`.
 *
 * If another process updates the registration before it can be updated by the
 * current process, then a conflict error will be thrown.
 *
 * @param {object} options - Options to use.
 * @param {object} options.registration - The registration to update.
 * @param {number} options.minAssuranceForResolution - The new minimum level of
 *   assurance required for token resolution.
 *
 * @returns {Promise<boolean>} Returns true if update occurred.
 */
 async function raiseMinAssuranceForResolution({
  registration, minAssuranceForResolution
} = {}) {
  if(minAssuranceForResolution < registration.minAssuranceForResolution) {
    throw new Error(
      'Invalid API usage; minAssuranceForResolution ' +
      `(${minAssuranceForResolution}) must be greater than or equal to ` +
      'registration.minAssuranceForResolution ' +
      `(${registration.minAssuranceForResolution}).`);
  }

  /* See `lowerMinAssuranceForResolution` for more details on non-atomic
  state changes/partitioned constraint state between registrations and token
  batches.

  Here we update the `minAssuranceForResolution` constraint on the registration
  first to ensure new token batches are created using the proper constraint.

  FIXME: that does not ensure those conditions! a process could read a stale
  registration record and then create a token batch with a stale constraint
  value ... how do we fix? ... can we use open batch collection and update
  it prior to invalidating existing token batches? ... even that doesn't help,
  we'd need the stale insert to reject based on the sequence number

  We then mark all token batches with a sequence number that predates the
  one used in the registration update we just performed as invalid.

  FIXME: need to ensure that if the raise constraint function completes
  with success that you are guaranteed that no token batches with a lower
  constraint exist unless they were created by a *subsequent* lowering of
  the contraint... one way to ensure this is to check that the registration
  value has not changed after inserting a new batch ... but this adds an
  additional call to every new batch creation... is that ok?

  FIXME: Can we only do one extra call which is to get the registration and
  check the sequence number ... and always do that *if* a token batch is
  full (no tokens have been issued yet)? Would that ensure that a process
  that is raising the constraint will succeed? Do we need to make that
  process invalidate token batches BEFORE updating the constraint and that
  would solve the issue? What's the sequence then?

  1. create token batch with constraint `1`
  2. check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it
  3. update token batches to constraint `2`
  4. update registration constraint to `2` ... SUCCESS ... BUT DO NOT DO THIS,
  AS IT CREATES THE FAILURE SHOWN NEXT ... INSTEAD CHANGE THE RAISE CONSTRAINT
  ORDER TO ENABLE ALL CASES BELOW THE FAILURE:

  1. update token batches to constraint `2`
  2. create token batch with constraint `1`
  3. check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it
  4. update registration constraint to `2` ... FAILS, NO GOOD! DO THE OTHER
  ORDER AS BELOW...

  A2 always follows A1
  B2 always follows B1
  AX and BX can interleave

  1. A1 - create token batch with constraint `1`
  2. A2 - check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it
  3. B1 - update registration constraint to `2`
  4. B2 - update token batches to constraint `2` ... SUCCESS, A1 invalidated

  1. B1 - update registration constraint to `2`
  2. B2 - update token batches to constraint `2`
  3. A1 - create token batch with constraint `1`
  4. A2 - check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it ... SUCCESS, A1 not used

  1. A1 create token batch with constraint `1`
  2. B1 update registration constraint to `2`
  3. B2 update token batches to constraint `2`
  4. A2 check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it ... SUCCESS, A1 not used

  1. B1 update registration constraint to `2`
  2. A1 create token batch with constraint `1`
  3. B2 update token batches to constraint `2`
  4. A2 check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it ... SUCCESS, A1 not used

  1. B1 update registration constraint to `2`
  2. A1 create token batch with constraint `1`
  3. A2 check registration, if sequence changed don't use token batch, create
    another one, if not changed, use it
  4. B2 update token batches to constraint `2` ... SUCCESS, A1 invalidated

  If A1 comes before B1, B2 invalidates A1
  If A1 comes after B1, A1 is not used because of A2
  Fixed.

  But, who does the clean up in the cases where A1 is not used? Probably
  whomever grabs that token batch needs to clean it up.

  COPIED FROM ABOVE... remove once we've got everything we need here...

  Here we ensure that we mark all token batches that were created prior to
  updating the re

  The `minAssuranceForResolution` constraint is set in multiple places that may
  safely get out of sync with one another. It must appear in more than one
  place due to architectural, security, and privacy requirements (e.g.,
  indexing, sharding, confidentiality of token/registration information) that
  enable hot code paths to execute quickly.

  One place is on a registration and the other is on the token batches for the
  `internalId` associated with that registration. To lower
  `minAssuranceForResolution`, first the registration is updated and then every
  token batch is updated.

  Since the above operation is neither wholly atomic nor isolated, we must
  consider what will happen if it is partially executed or if a concurrent
  process modifies the same state.

  There are two calls to consider:

  1. Updating the registration.
  2. Updating the token batches.

  The first call is internally atomic -- and if it fails, the second call
  will not be executed (this is the simplest case and it is not considered
  below). The second call is not entirely internally atomic; each individual
  token batch update is but updating all of them (if there is more than one)
  is not.

  Therefore, we have the following cases to consider in order to explain
  how an acceptable state will always be reached after the first call
  is successfully executed:

  1. We never execute the second call (e.g., we crash before calling it).
  2. Another process changes the registration's constraint to another
    value while we make the second call.
  3. Another process changes some token batch constraints to another
    value while we make the second call.
  4. The second call results in only a partial update (e.g., we crash
    during the call) or a read occurs on a token batch that has not yet
    been updated during the call.

  Case 1: We never execute the second call.

  The registration will be marked as having a lower constraint but any
  token batches will maintain whatever their current value was. So, what
  will happen if someone tries to resolve those tokens?

  If a token from a token batch with a higher constraint is used, then token
  resolution will fail and require additional identity assurance to be provided
  and a potential need to call this function to lower
  `minAssuranceForResolution` again. This is considered acceptable as it causes
  us to simply repeat the action we were trying to do before.

  If a token instead has a lower constraint, then the token will resolve. We
  presume that having a token in this state is valid, i.e., that it arrived at
  this state through some previous valid operation and this state is therefore
  also not an issue.

  Case 2: Another process changes the registration's constraint to another
    value while we make the second call.

  Here we may mark some token batches with a constraint that is different
  from the registration's new constraint. If the value we're setting is lower
  than the new one, this means that our update could replace a newly set higher
  value with a lower one, enabling the batch to be used to resolve a token even
  though a more recent update to the registration intended to prevent this from
  happening. This is not an acceptable outcome.

  In order to address this case, we must ensure, when raising the constraint
  that all token batches created prior to setting the constraint on the
  registration are invalidated. Since a new token batch could be created while
  the registration itself is being updated, we must update the registration's
  constraint first and we cannot rely on a current matching constraint value
  from the registration as an indication that the token batches have been made
  consistent -- as we may crash prior to invalidating token batches marked
  with a lower constraint.

  We must also consider that, while raising the registration constraint,
  another process may be in line to lower it again. This other process
  may create token batches with a lower constraint that our process goes on
  to erroneously mark as invalid. In order to prevent this from happening, we
  use a sequence update number on the registration record that is copied to the
  token batches. This enables us to keep track of which registration record
  instance was considered when the token batch was created. This enables the
  invalidate process to only consider token batches that were created prior to
  the registration record update, avoiding invalidating new token batches.

  This sequence number is also used to avoid changes to the constraint that are
  out of sequence, causing a conflict error to be thrown instead of making an
  out of order change. This eliminates the case where another process makes
  a change concurrently with our own; it can only be the case that the other
  process is a *subsequent* update -- and its changes should take precedence
  over our own.

  Case 3: Another process changes some token batch constraints to another
    value while we make the second call.

  If the other process is lowering the constraint further, than there are
  no significant differences from Case 1. We may mark a token batch with
  a higher constraint thus triggering a need to lower the constraint again.

  If the other process is raising the constraint, then as long as we limit
  our updates to token batches that have a sequence number that is less
  than the new one for the registration, we will not update any new token
  batches with an erroneously low constraint. If the sequence number increases
  on the registration for a reason other than an update to the constraint,
  then we will again fall into Case 1.

  Case 4: The second call results in only a partial update (e.g., we crash
    during the call) or a read occurs on a token batch that has not yet
    been updated during the call.

  Any token batches that are read with a different constraint value will be
  treated just as in Case 1. */

  // lower minAssuranceForResolution on registration and token batches
  const {sequence, documentHash, externalIdHash, internalId} = registration;
  await documents._setMinAssuranceForResolution({
    sequence, externalIdHash, documentHash, minAssuranceForResolution
  });
  await tokens._setMinAssuranceForResolution({
    internalId, minAssuranceForResolution
  });
}
