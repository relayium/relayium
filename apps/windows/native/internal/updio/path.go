// Splitting a resolved Windows path into the chain that will be traversed.
//
// Kept platform-free so it is TESTED rather than merely cross-compiled: this is
// string handling on a value that decides which directories get pinned, and it
// is the kind of code that looks obvious and is wrong for `\\?\UNC\` inputs.
package updio

import "strings"

// SplitPhysical turns an absolute local path into a drive letter and the
// components below it.
//
// The input is the path AS SUPPLIED — deliberately not a resolved one. The
// extended `\\?\C:\...` form is accepted because a caller may hand one over,
// but nothing here resolves anything: the components come out exactly as they
// went in, so a junction among them is still present to be refused when the
// traversal opens it. Everything that is not a plain local drive is refused:
//
//   - `\\?\UNC\server\share\...` — a network path has no local volume to anchor
//     on, and pinning "the share" pins nothing on this machine;
//   - `\\server\share\...` — the same thing without the prefix;
//   - `\\?\Volume{GUID}\...` — a volume with no drive letter, which
//     `QueryDosDeviceW` cannot be asked about the way this code asks;
//   - anything relative, or a bare `C:` with no root.
//
// A refusal here is a refusal to update, which is the honest outcome for a
// layout this cannot pin.
func SplitPhysical(resolved string) (volume string, components []string, err error) {
	path := strings.ReplaceAll(resolved, "/", `\`)
	if strings.HasPrefix(path, `\\?\UNC\`) || strings.HasPrefix(path, `\\.\`) {
		return "", nil, Errf(CodeRedirected)
	}
	path = strings.TrimPrefix(path, `\\?\`)
	if strings.HasPrefix(path, `\\`) {
		return "", nil, Errf(CodeRedirected)
	}
	if strings.HasPrefix(path, "Volume{") {
		// A volume with no drive letter. Not malformed — just a layout this
		// cannot ask `QueryDosDeviceW` about, so it is refused as unanchorable.
		return "", nil, Errf(CodeRedirected)
	}
	if len(path) < 3 || path[1] != ':' || path[2] != '\\' {
		return "", nil, Errf(CodeBadName)
	}
	letter := path[0]
	if !(letter >= 'A' && letter <= 'Z') && !(letter >= 'a' && letter <= 'z') {
		return "", nil, Errf(CodeRedirected)
	}
	volume = path[:2]
	for _, part := range strings.Split(path[3:], `\`) {
		if part == "" {
			continue
		}
		if part == "." || part == ".." {
			// A final path should not contain these. One surviving here means
			// the input is not what this expects, and walking it would be
			// guessing.
			return "", nil, Errf(CodeBadName)
		}
		components = append(components, part)
	}
	if len(components) == 0 {
		// The volume root itself is not an app data root.
		return "", nil, Errf(CodeBadName)
	}
	return volume, components, nil
}
