package updio

import (
	"encoding/json"
	"fmt"
	"io"
)

func decodeRequest(payload []byte) (Request, error) {
	var req Request
	decoder := json.NewDecoder(newBytesReader(payload))
	// Unknown fields are refused rather than ignored: a request this build does
	// not understand is not a request it should half-perform.
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return Request{}, fmt.Errorf("updio: decode: %w", err)
	}
	if decoder.More() {
		return Request{}, fmt.Errorf("updio: trailing content in control frame")
	}
	return req, nil
}

// dispatch answers one request.
//
// The second value is a payload frame to send after the reply; the third ends
// the session when non-nil.
func dispatch(
	in io.Reader, custody Custody, req Request, state *session,
) (Reply, []byte, error) {
	switch req.Op {
	case OpHello:
		return Reply{OK: true, Version: ProtocolVersion}, nil, nil

	case OpScopeOpen:
		if state.opened {
			// Not replaced: later requests must act through the handles their
			// authority was established against.
			return fail(CodeProtocol), nil, nil
		}
		if req.Root == "" || !InertName(req.Component) {
			return fail(CodeBadName), nil, nil
		}
		if err := custody.Open(req.Root, req.Component); err != nil {
			return fail(codeOf(err)), nil, nil
		}
		state.opened = true
		return Reply{OK: true}, nil, nil
	}

	if !state.opened {
		return fail(CodeNoScope), nil, nil
	}

	switch req.Op {
	case OpCustodyCreate:
		if !InertName(req.Name) {
			return fail(CodeBadName), nil, nil
		}
		if len(state.handles) >= MaxOpenHandles {
			// Refused rather than evicted: closing somebody else's handle to
			// make room would drop a write nobody asked to abandon.
			return fail(CodeHandles), nil, nil
		}
		handle, receipt, err := custody.CreateExclusive(req.Name)
		if err != nil {
			return fail(codeOf(err)), nil, nil
		}
		state.handles[handle] = struct{}{}
		return Reply{OK: true, Handle: handle, Receipt: receipt}, nil, nil

	case OpCustodyWrite:
		if req.Bytes <= 0 || req.Bytes > MaxChunkBytes {
			return fail(CodeTooLarge), nil, nil
		}
		// The payload frame must be the very next thing on the stream. Reading
		// it before deciding anything keeps the stream in step even when the
		// write itself is refused.
		kind, chunk, err := ReadFrame(in, MaxChunkBytes)
		if err != nil {
			return fail(CodeProtocol), nil, err
		}
		if kind != KindBytes || len(chunk) != req.Bytes {
			return fail(CodeProtocol), nil, Errf(CodeProtocol)
		}
		if err := custody.Write(req.Handle, chunk); err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true}, nil, nil

	case OpCustodySync:
		if err := custody.Sync(req.Handle); err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true}, nil, nil

	case OpCustodyCommit:
		if !InertName(req.To) {
			return fail(CodeBadName), nil, nil
		}
		if err := custody.Commit(req.Handle, req.To); err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true}, nil, nil

	case OpCustodyClose:
		// Release WITHOUT deleting. The object stays and its receipt stays
		// valid, so a later `scope.remove` can still prove what it is removing.
		if _, held := state.handles[req.Handle]; !held {
			return fail(CodeNoHandle), nil, nil
		}
		if err := custody.Release(req.Handle); err != nil {
			return fail(codeOf(err)), nil, nil
		}
		delete(state.handles, req.Handle)
		return Reply{OK: true}, nil, nil

	case OpCustodyDiscard:
		if _, held := state.handles[req.Handle]; !held {
			return fail(CodeNoHandle), nil, nil
		}
		gone, err := custody.Discard(req.Handle)
		if err != nil {
			return fail(codeOf(err)), nil, nil
		}
		// Discard consumes the handle whether or not the delete confirmed: the
		// object is either gone or is residue the host now owns by receipt.
		delete(state.handles, req.Handle)
		return Reply{OK: true, Gone: gone}, nil, nil

	case OpScopeIdentity:
		if !InertName(req.Name) {
			return fail(CodeBadName), nil, nil
		}
		receipt, present, err := custody.Identity(req.Name)
		if err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true, Present: present, Receipt: receipt}, nil, nil

	case OpScopeRemove:
		if !InertName(req.Name) {
			return fail(CodeBadName), nil, nil
		}
		if req.Receipt == "" {
			// A name is not authority. Without a receipt there is nothing to
			// compare the object against, so nothing is removed.
			return fail(CodeIdentity), nil, nil
		}
		gone, err := custody.Remove(req.Name, req.Receipt)
		if err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true, Gone: gone}, nil, nil

	case OpScopeRead:
		if !InertName(req.Name) {
			return fail(CodeBadName), nil, nil
		}
		// Bounded by the RECORD limit, not by the control-frame limit. The reply
		// carries the document in a payload frame precisely because a journal of
		// legitimate size does not fit in a control frame — and because JSON
		// escaping would expand it further. A larger request is refused, never
		// clamped: clamping would turn "this record is too big" into a short
		// read the caller could not tell from a whole one.
		if req.Max <= 0 || req.Max > MaxJournalBytes {
			return fail(CodeTooLarge), nil, nil
		}
		content, present, err := custody.ReadBounded(req.Name, req.Max)
		if err != nil {
			// Oversized and unreadable stay ERRORS. Reporting either as absent
			// would let the core treat a record it could not read as "nothing
			// staged" and overwrite a real candidate.
			return fail(codeOf(err)), nil, nil
		}
		if !present {
			return Reply{OK: true, Present: false}, nil, nil
		}
		return Reply{OK: true, Present: true, Bytes: len(content)}, content, nil

	case OpScopeHash:
		if !InertName(req.Name) || req.Receipt == "" || req.Size <= 0 {
			return fail(CodeBadName), nil, nil
		}
		sum, present, err := custody.HashOwned(req.Name, req.Receipt, req.Size)
		if err != nil {
			return fail(codeOf(err)), nil, nil
		}
		return Reply{OK: true, Present: present, SHA256: sum}, nil, nil

	case OpInstallVerify, OpInstallRun:
		if !InertName(req.Name) || req.Receipt == "" || req.SHA256 == "" || req.Size <= 0 {
			return fail(CodeBadName), nil, nil
		}
		if req.Publisher == "" && req.Op == OpInstallRun {
			// No pin, no install. Not a wildcard and not a warning.
			//
			// `install.verify` is allowed without one because it CLASSIFIES and
			// never launches: the host needs to tell an unsigned artifact from a
			// signed one before any certificate is provisioned. It still cannot
			// return `signed-by-expected-publisher` without an expectation to
			// compare against — see `verifyHeld`.
			return fail(CodeNoPin), nil, nil
		}
		if req.Op == OpInstallRun && req.Consent != "granted" {
			// Consent has no default here either: an absent or misspelled value
			// is a refusal, not an assumption.
			return fail(CodeCancelled), nil, nil
		}
		verify := custody.VerifyInstaller
		if req.Op == OpInstallRun {
			verify = custody.RunInstaller
		}
		verdict, err := verify(req.Name, req.Receipt, req.SHA256, req.Publisher, req.Size)
		if err != nil {
			return Reply{OK: false, Code: codeOf(err), Verdict: verdict}, nil, nil
		}
		return Reply{OK: true, Verdict: verdict}, nil, nil
	}
	return fail(CodeProtocol), nil, nil
}
