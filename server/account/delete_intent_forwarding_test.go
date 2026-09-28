package account

import "context"

// The test wrappers that embed Store and are handed to GC, the share-delete
// route or the account-deletion cleanup forward deleteIntentStore EXPLICITLY.
// Embedding Store does not promote them (they are not on the interface), and
// deleteIntentStore is required, not optional: without these the wrapped paths
// refuse to delete anything (errNoDeleteIntentStore), which is the production
// behaviour for such a store but not what these tests are about.
//
// flakyStore also lets each of them be failed by name, like its other methods.

func innerIntent(st Store) deleteIntentStore {
	q, err := intentStore(st)
	if err != nil {
		panic(err)
	}
	return q
}

func (f *flakyStore) DeleteStoredFileQueuingBlob(ctx context.Context, id string, now int64) (bool, error) {
	if f.shouldFail("DeleteStoredFileQueuingBlob") {
		return false, errInjected
	}
	return innerIntent(f.Store).DeleteStoredFileQueuingBlob(ctx, id, now)
}

func (f *flakyStore) DeleteTaskObjectIfReclaimableQueuingBlob(ctx context.Context, id string, now, bindGrace int64) (bool, error) {
	if f.shouldFail("DeleteTaskObjectIfReclaimableQueuingBlob") {
		return false, errInjected
	}
	return innerIntent(f.Store).DeleteTaskObjectIfReclaimableQueuingBlob(ctx, id, now, bindGrace)
}

func (f *flakyStore) DischargePendingNodeDelete(ctx context.Context, blobKey, nodeID string, now int64) error {
	if f.shouldFail("DischargePendingNodeDelete") {
		return errInjected
	}
	return innerIntent(f.Store).DischargePendingNodeDelete(ctx, blobKey, nodeID, now)
}

func (f *flakyStore) MarkPendingNodeDeleteAttempted(ctx context.Context, blobKey, nodeID string) error {
	if f.shouldFail("MarkPendingNodeDeleteAttempted") {
		return errInjected
	}
	return innerIntent(f.Store).MarkPendingNodeDeleteAttempted(ctx, blobKey, nodeID)
}

func (q *quotaHookStore) DeleteStoredFileQueuingBlob(ctx context.Context, id string, now int64) (bool, error) {
	return innerIntent(q.Store).DeleteStoredFileQueuingBlob(ctx, id, now)
}

func (q *quotaHookStore) DeleteTaskObjectIfReclaimableQueuingBlob(ctx context.Context, id string, now, bindGrace int64) (bool, error) {
	return innerIntent(q.Store).DeleteTaskObjectIfReclaimableQueuingBlob(ctx, id, now, bindGrace)
}

func (q *quotaHookStore) DischargePendingNodeDelete(ctx context.Context, blobKey, nodeID string, now int64) error {
	return innerIntent(q.Store).DischargePendingNodeDelete(ctx, blobKey, nodeID, now)
}

func (q *quotaHookStore) MarkPendingNodeDeleteAttempted(ctx context.Context, blobKey, nodeID string) error {
	return innerIntent(q.Store).MarkPendingNodeDeleteAttempted(ctx, blobKey, nodeID)
}

func (f *flakyStore) DeletePendingNodeDelete(ctx context.Context, blobKey, nodeID string) error {
	if f.shouldFail("DeletePendingNodeDelete") {
		return errInjected
	}
	return f.Store.DeletePendingNodeDelete(ctx, blobKey, nodeID)
}
