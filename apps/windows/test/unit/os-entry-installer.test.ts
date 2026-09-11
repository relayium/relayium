// The Explorer send entries, as the installer template declares them.
//
// SCOPE: this file reads `assets/installer.nsh` and asserts what it WRITES. It
// does not run NSIS, does not touch a registry, and cannot show that Windows
// honours any of it — the installed acceptance does that on a real runner, and
// what Explorer does when a verb is invoked is beyond either of them.
//
// It exists because the values here are load-bearing strings that no compiler
// checks: a missing quote, a prefix comparison where an exact one was meant, or
// a verb that quietly becomes a default association are all one character away
// and all invisible until a user's machine is wrong.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const nsh = readFileSync(
  fileURLToPath(new URL("../../assets/installer.nsh", import.meta.url)),
  "utf8",
);

/** The command both verbs write, with `$INSTDIR` and the exe left symbolic. */
const SEND_COMMAND = '\'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --send-files "%1"\'';

describe("the Explorer send entries", () => {
  it("registers a verb for files AND for folders", () => {
    expect(nsh).toContain('!define RELAYIUM_SEND_FILE_KEY "Software\\Classes\\*\\shell\\${RELAYIUM_SEND_VERB}"');
    expect(nsh).toContain('!define RELAYIUM_SEND_DIR_KEY "Software\\Classes\\Directory\\shell\\${RELAYIUM_SEND_VERB}"');
  });

  it("writes them per-user only", () => {
    // A per-user install has no business in HKLM, and a machine-wide verb would
    // appear for every account on the PC.
    const writes = nsh.match(/^\s*Write\w+ \w+ "\$\{RELAYIUM_SEND_(?:FILE|DIR)_KEY\}/gm) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write).toContain("HKCU");
    // The word appears once, in a comment saying nothing writes there. What
    // must not exist is a WRITE.
    expect(nsh).not.toMatch(/^\s*Write\w+ HKLM/m);
  });

  it("declares each verb SINGLE-selection", () => {
    // The whole multi-selection answer. Without this Windows invokes the verb
    // once per selected item, and a send that holds one pending selection would
    // have each launch replace the last — forty files chosen, one sent, no error.
    const singles = nsh.match(/WriteRegStr HKCU "\$\{RELAYIUM_SEND_(FILE|DIR)_KEY\}" "MultiSelectModel" "Single"/g);
    expect(singles).toHaveLength(2);
  });

  it("passes exactly one quoted path after the flag", () => {
    const commands = nsh.match(/--send-files "%1"/g) ?? [];
    // Both verbs, and the uninstaller's two ownership comparisons.
    expect(commands.length).toBe(4);
    // Quoted executable AND quoted argument: a destination with a space or a
    // non-ASCII user folder is ordinary, and either would truncate unquoted.
    for (const key of ["RELAYIUM_SEND_FILE_KEY", "RELAYIUM_SEND_DIR_KEY"]) {
      expect(nsh).toContain(`WriteRegStr HKCU "\${${key}}\\command" "" ${SEND_COMMAND}`);
    }
  });

  it("labels the verb in BOTH maintained languages, English as the fallback", () => {
    // The one string here a person reads. Relayium maintains English and
    // Simplified Chinese, and a hardcoded English label would have shipped a
    // zh-Hans installer with an English entry in its context menu.
    expect(nsh).toContain('StrCpy $R0 "Send with Relayium"');
    expect(nsh).toContain('StrCpy $R0 "使用 Relayium 发送"');
    // Selected by the installer's own LCID, the same mechanism the refusal
    // messages use. 2052 is zh-Hans.
    const label = nsh.indexOf('StrCpy $R0 "Send with Relayium"');
    expect(nsh.indexOf("${If} $LANGUAGE == 2052", label)).toBeGreaterThan(label);
    // English is assigned FIRST and overwritten, so any language that is not
    // 2052 gets it — the declared fallback rather than an empty label.
    expect(nsh.indexOf('StrCpy $R0 "使用 Relayium 发送"')).toBeGreaterThan(label);
  });

  it("writes the SAME label to both keys", () => {
    // Two entries for one command must not drift into different words.
    expect(nsh).toContain('WriteRegStr HKCU "${RELAYIUM_SEND_FILE_KEY}" "" "$R0"');
    expect(nsh).toContain('WriteRegStr HKCU "${RELAYIUM_SEND_DIR_KEY}" "" "$R0"');
    // And the literal is not also written directly anywhere.
    expect(nsh).not.toMatch(/WriteRegStr[^\n]*"Send with Relayium"/);
  });

  it("balances the register the label borrows", () => {
    const macro = nsh.slice(nsh.indexOf("!macro customInstall"));
    const body = macro.slice(0, macro.indexOf("!macroend"));
    expect(body.split("Push $R0").length - 1).toBe(body.split("Pop $R0").length - 1);
    expect(body.split("Push $R0").length - 1).toBe(1);
  });

  it("creates no default association", () => {
    // Double-clicking a file must be exactly as it was. A ProgId, a file-type
    // DefaultIcon or an OpenWithProgids entry would each change that.
    // Asserted as WRITES, not as words: the template's own comment says it
    // registers no `OpenWithProgids`, and a test that banned the string would
    // fail on the sentence promising the behaviour it is checking for.
    expect(nsh).not.toMatch(/Write\w+ \w+ "[^"]*OpenWithProgids/);
    expect(nsh).not.toMatch(/Write\w+ \w+ "[^"]*FileExts/);
    // No `Software\Classes\.ext` key, which is what claiming a file type means.
    expect(nsh).not.toMatch(/Write\w+ HKCU "Software\\Classes\\\./);
  });
});

describe("the SendTo entry", () => {
  it("is the BULK path, carrying the flag and nothing else", () => {
    // Explorer appends every selected path after these arguments, in ONE
    // launch. That is the mechanism Windows provides for a multiple selection,
    // and it is why the context verb does not try to be one.
    // Written across continuation lines, so the pieces are asserted rather
    // than one brittle single-line pattern.
    expect(nsh).toContain('CreateShortCut "$SENDTO\\${RELAYIUM_SENDTO_NAME}"');
    expect(nsh).toContain('"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "--send-files"');
  });

  it("lives in the user's own SendTo folder", () => {
    expect(nsh).toContain("$SENDTO\\${RELAYIUM_SENDTO_NAME}");
  });
});

describe("uninstalling removes only what this installation wrote", () => {
  it("compares each command EXACTLY, never by prefix or by existence", () => {
    // The rule the scheme registration already follows, applied to the new
    // entries: a prefix test also accepts a different program dropped in the
    // directory, and `$INSTDIR\..\other.exe`.
    const exact = `\${If} $0 == ${SEND_COMMAND}`;
    expect(nsh.split(exact).length - 1).toBe(2);
    // And each is followed by a delete of that key alone.
    expect(nsh).toContain('DeleteRegKey HKCU "${RELAYIUM_SEND_FILE_KEY}"');
    expect(nsh).toContain('DeleteRegKey HKCU "${RELAYIUM_SEND_DIR_KEY}"');
  });

  it("leaves a foreign replacement alone, and says so", () => {
    // A verb of the same NAME pointing elsewhere is somebody else's. The name
    // is the cheapest thing to collide on, which is why it cannot be the test.
    const kept = nsh.match(/DetailPrint "Leaving the (file|folder|SendTo) [^"]*: it does not name this installation"/g);
    expect(kept).toHaveLength(3);
  });

  it("matches the SendTo shortcut on BOTH its target and its arguments", () => {
    // A shortcut has no registry value to compare. The same name pointing at
    // another program — or at this one with different arguments — is not ours.
    // Through COM, not a plugin. The pinned toolchain ships no ShellLink, and
    // `WinShell.dll` exports only SetLnkAUMI / UninstAppUserModelId /
    // UninstShortcut — a macro written against the missing plugin would compile
    // nowhere and fail on the build runner rather than here.
    // A CALL, not the word: the template's own comment names the plugin while
    // explaining why it is not used, and a test banning the string would fail on
    // the sentence documenting the behaviour it checks for. Comment lines start
    // with `;`, so an invocation is what this matches.
    expect(nsh).not.toMatch(/^\s*ShellLink::/m);
    expect(nsh).toContain("ole32::CoCreateInstance");
    expect(nsh).toContain("${CLSID_SHELLLINK}");
    expect(nsh).toContain("${IID_IPERSISTFILE}");
    // GetPath is vtable 3 and GetArguments is vtable 10 on IShellLinkW; Load is
    // vtable 5 on IPersistFile. Asserted so a renumbering is caught here.
    expect(nsh).toMatch(/\$1->3\(w \.r2, i \$\{NSIS_MAX_STRLEN\}, i 0, i \$\{SLGP_RAWPATH\}\)/);
    expect(nsh).toMatch(/\$1->10\(w \.r3, i \$\{NSIS_MAX_STRLEN\}\)/);
    expect(nsh).toMatch(/\$4->5\(w '\$SENDTO/);
    // Released, both of them.
    expect(nsh).toContain("$4->2()");
    expect(nsh).toContain("$1->2()");
    expect(nsh).toContain("ole32::CoUninitialize");
    // `$2` and `$3` hold what COM actually read back.
    expect(nsh).toContain('${If} $2 == "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(nsh).toContain('${AndIf} $3 == "--send-files"');
  });

  it("checks CoInitialize's OWN result, in its own register", () => {
    // It was read into `$0` and then overwritten by `CoCreateInstance`, so the
    // initialisation was never checked. A separate register is what makes the
    // guard below possible at all.
    expect(nsh).toContain('System::Call "ole32::CoInitialize(i 0) i .r5"');
    expect(nsh).not.toContain('System::Call "ole32::CoInitialize(i 0) i .r0"');
  });

  it("uninitialises ONLY after an initialise that succeeded", () => {
    // `S_OK` (0) and `S_FALSE` (1) are the only results that owe a matching
    // `CoUninitialize`. On `RPC_E_CHANGED_MODE` or any other failure, calling it
    // would tear down an apartment this uninstaller does not own, in a process
    // it shares.
    expect(nsh).toContain("${If} $5 == 0");
    expect(nsh).toContain("${OrIf} $5 == 1");
    // Structural: the guard opens BEFORE the read, and the uninitialise sits
    // after the read rather than trailing outside the guard.
    const guardAt = nsh.indexOf("${OrIf} $5 == 1");
    const createAt = nsh.indexOf("ole32::CoCreateInstance");
    const uninitAt = nsh.indexOf("ole32::CoUninitialize");
    expect(guardAt).toBeGreaterThan(0);
    expect(createAt).toBeGreaterThan(guardAt);
    expect(uninitAt).toBeGreaterThan(createAt);
  });

  it("balances every register it borrows", () => {
    // `$5` joined the macro with the guard. An unbalanced Push/Pop corrupts a
    // caller's register, and nothing in NSIS catches it.
    const macro = nsh.slice(nsh.indexOf("!macro customUnInstall"));
    const body = macro.slice(0, macro.indexOf("!macroend"));
    for (const reg of ["$0", "$1", "$2", "$3", "$4", "$5"]) {
      const pushes = body.split(`  Push ${reg}\n`).length - 1;
      const pops = body.split(`  Pop ${reg}\n`).length - 1;
      expect([reg, pushes]).toEqual([reg, pops]);
    }
  });

  it("leaves the shortcut alone when it could not be READ", () => {
    // Fail closed. A link this uninstaller could not read is one it cannot
    // claim, and the comparison runs against empty strings that match nothing.
    expect(nsh).toContain('StrCpy $2 ""');
    expect(nsh).toContain('StrCpy $3 ""');
    expect(nsh).toContain("cannot be loaded, or either accessor fails");
  });

  it("removes the shortcut by path, not by wildcard", () => {
    expect(nsh).toContain('Delete "$SENDTO\\${RELAYIUM_SENDTO_NAME}"');
    expect(nsh).not.toContain('Delete "$SENDTO\\*');
  });
});

describe("the template stays honest about what it cannot do", () => {
  it("documents the per-item invocation it is avoiding", () => {
    // The reason `MultiSelectModel` is there at all. A future edit that removes
    // the attribute without reading this would reintroduce the silent failure.
    expect(nsh).toContain("PER ITEM");
  });

  it("documents that SendTo is still bounded by the command line", () => {
    expect(nsh).toContain("command-line limit");
  });
});


// ---------------------------------------------------------------------------
// The installed driver's identifiers actually resolve
// ---------------------------------------------------------------------------
//
// A bare `join(...)` shipped to a Windows runner and threw `ReferenceError: join
// is not defined` at line 625, before the installer had run — the file imports
// `path` as a default, not `{ join }`. `node --check` passed it, because parsing
// is grammar: the call is well-formed whether or not the name exists.
//
// So the binding is checked here, statically, on every run of this suite. The
// driver itself cannot run on this host, which is exactly why nothing else would
// have caught it before CI did.
const driver = readFileSync(
  fileURLToPath(new URL("../smoke/installed-acceptance.mjs", import.meta.url)),
  "utf8",
);

describe("the installed-acceptance driver resolves every name it uses", () => {
  it("imports `path` as a default and never calls a bare join", () => {
    expect(driver).toContain('import path from "node:path"');
    // The precise defect: `join(` not preceded by a dot or a word character.
    expect(driver).not.toMatch(/(?<![.\w])join\(/);
  });

  it("binds every identifier it reads", () => {
    // Through the TYPESCRIPT COMPILER, not a scope walker written here.
    //
    // The first version of this guard was a hand-rolled AST walk, and it was
    // wrong within minutes: it reported `close` as unbound because it had no
    // case for a class method's name. Rediscovering JavaScript's scoping rules
    // in a test is a second implementation to get wrong, and the project
    // already depends on a compiler that knows them.
    //
    // Only the missing-name diagnostics are read — 2304 "Cannot find name" and
    // 2552 "Cannot find name, did you mean" — so this stays a BINDING check.
    // Whatever else `checkJs` would say about an untyped driver is a different
    // question and is not asserted here.
    const driverPath = fileURLToPath(new URL("../smoke/installed-acceptance.mjs", import.meta.url));
    const program = ts.createProgram([driverPath], {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      typeRoots: [fileURLToPath(new URL("../../node_modules/@types", import.meta.url))],
    });
    const source = program.getSourceFile(driverPath);
    expect(source).toBeDefined();

    const missing = program
      .getSemanticDiagnostics(source)
      .filter((d) => d.code === 2304 || d.code === 2552)
      .map((d) => {
        const { line } = source!.getLineAndCharacterOfPosition(d.start ?? 0);
        return `${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
      });
    expect(missing).toEqual([]);
  });
});
