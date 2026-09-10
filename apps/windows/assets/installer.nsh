; Refuse an installation destination that would take the private data directory
; with it.
;
; ## The failure this prevents
;
; `allowToChangeInstallationDirectory: true` lets the destination be chosen — on
; the directory page, or with `/D=` on a silent command line. Nothing stops that
; choice from naming `%LOCALAPPDATA%\Relayium`, which is where
; `src/main/storage.ts` keeps this installation's identity, the account bearer
; and the Device Inbox private key. Install there and the next upgrade or
; uninstall deletes all three: the user silently becomes a new device, their
; inbox key is gone, and nothing reports an error, because deleting the install
; directory is exactly what an uninstall is supposed to do.
;
; The runtime check in `storage.ts` cannot save this. It refuses to WRITE into a
; doomed directory, but it runs after extraction — by which point the previous
; identity is already gone. The refusal has to happen HERE.
;
; ## Where this runs, precisely
;
; `customInit` is inserted by the pinned template into `.onInit`, after
; `initMultiUser`. `.onInit` completes BEFORE any page is shown, so what
; `customInit` validates is the destination the run STARTS with: the default, or
; a `/D=` override. For a silent install that is the final answer.
;
; On an interactive run the user can then change it, and `customInit` does not
; run again — there is no post-selection `customInit`. `.onVerifyInstDir` is what
; covers that: NSIS calls it every time `$INSTDIR` changes on the directory page.
; Only `Abort` belongs in it — it greys out Next rather than raising a dialog on
; every keystroke.
;
; ## Coupled to storage.ts
;
; `APP_DIRECTORY` in `src/main/storage.ts` is the same literal. Guarding a
; different directory than the one holding the keys guards nothing;
; `storage.test.ts` asserts the two spellings match.

; LogicLib explicitly, and not by luck. electron-builder emits this file into
; the COMMON header, which is assembled before `common.nsh` and MUI pull in
; `LogicLib.nsh` — so `${If}` is not a command yet at this point in the script.
; Without this line makensis fails with `Invalid command: "${If}"` and no
; installer is produced. LogicLib guards its own re-inclusion, so asking for it
; here costs nothing where it is already present.
!include "LogicLib.nsh"

!define RELAYIUM_PRIVATE_DIR_NAME "Relayium"

; Error levels a silent caller can observe. Distinct, so an acceptance test can
; assert WHICH refusal happened rather than just "non-zero".
!define RELAYIUM_ERR_COLLIDES 2
!define RELAYIUM_ERR_UNVERIFIABLE 3

!define RELAYIUM_FILE_SHARE_ALL 7            ; READ|WRITE|DELETE
!define RELAYIUM_OPEN_EXISTING 3
!define RELAYIUM_BACKUP_SEMANTICS 0x02000000 ; required to open a directory
!define RELAYIUM_VOLUME_NAME_GUID 1          ; FILE_NAME_NORMALIZED | VOLUME_NAME_GUID
!define RELAYIUM_ERROR_FILE_NOT_FOUND 2
!define RELAYIUM_ERROR_PATH_NOT_FOUND 3
!define RELAYIUM_MAX_CLIMB 64

; An NSIS variable holds at most NSIS_MAX_STRLEN - 1 characters; the buffer's
; last slot is the terminator. So `StrLen` on a variable can never reach
; NSIS_MAX_STRLEN, and a saturation test written against that value is dead
; code — which is what an earlier revision of this file contained.
;
; Verified rather than assumed: the pinned toolchain
; (`nsis-3.0.4.1`, electron-builder's cached build) reports
; NSIS_MAX_STRLEN = 8192, a large-strings build rather than the stock 1024.
; Probed by compiling `!error "…${NSIS_MAX_STRLEN}"` with that exact makensis.
!define /math RELAYIUM_STR_CAP ${NSIS_MAX_STRLEN} - 1

; ---------------------------------------------------------------------------
; Canonicalise $R8 to ONE physical namespace.
;
; Out: $R7 = `\\?\Volume{GUID}\...` form, $R6 = "ok" | "net" | "bad".
;
; ## Why volume GUIDs and not GetFullPathName
;
; `GetFullPathName` is lexical: it collapses `.`, `..` and duplicate separators
; and nothing else. An earlier revision of this file compared its output, plus
; 8.3 short forms, and called that sufficient. It is not. A junction or symlink
; aimed at the private directory passes it, and so — importantly — do `subst`
; drives and two drive letters mounted on one volume, which are object-manager
; namespace aliases carrying NO reparse attribute anywhere on the path. Any
; scheme that looks for reparse points to decide whether canonicalisation is
; needed misses exactly those.
;
; `GetFinalPathNameByHandleW` asks the kernel what the handle actually names, so
; junctions, symlinks, `subst`, mount points and 8.3 all collapse at once.
; `VOLUME_NAME_GUID` rather than `VOLUME_NAME_DOS` because two drive letters on
; one volume must compare equal, and only the GUID form makes them.
;
; ## Fail closed
;
; Both sides must reach the SAME namespace or the comparison is meaningless, so
; there is no raw-spelling fallback and no GUID-against-DOS compare. Anything
; that cannot be resolved is refused, not guessed at.
!macro RelayiumResolve uid
  Push $0 ; current path being probed
  Push $1 ; scratch / parent
  Push $2 ; handle
  Push $3 ; scratch / index / last error
  Push $4 ; scratch / char / returned length
  Push $5 ; accumulated unresolved tail
  Push $9 ; climb counter

  StrCpy $R6 "bad"
  StrCpy $R7 ""
  StrCpy $5 ""
  StrCpy $9 0

  ; A string already at capacity may have been truncated on the way in, and a
  ; truncated path names a different directory than the one asked about. Both
  ; the raw input and its normalised form are checked, at the CAPACITY — one
  ; below NSIS_MAX_STRLEN — because that is the largest a variable can hold.
  StrLen $1 $R8
  ${If} $1 >= ${RELAYIUM_STR_CAP}
    Goto rr_done_${uid}
  ${EndIf}

  ; Syntactic UNC first, BEFORE any filesystem call. Two reasons: a network
  ; destination is unsupported outright (the GUID form is documented as
  ; unavailable over SMB, so it could never be canonicalised into the same
  ; namespace as a local path), and `.onVerifyInstDir` runs on every keystroke —
  ; opening a handle on a half-typed `\\server\...` would stall the directory
  ; page on an SMB lookup.
  StrCpy $1 $R8 2
  ${If} $1 == "\\"
    StrCpy $R6 "net"
    Goto rr_done_${uid}
  ${EndIf}

  ; Lexical pass first. Not the guard — it just shortens the climb below and
  ; keeps `..` out of the strings being taken apart.
  ClearErrors
  GetFullPathName $0 $R8
  ${If} ${Errors}
    StrCpy $0 $R8
  ${EndIf}

  ; `GetFullPathName` writes into a variable too, so the same ceiling applies to
  ; its output independently of the input length.
  StrLen $1 $0
  ${If} $1 >= ${RELAYIUM_STR_CAP}
    Goto rr_done_${uid}
  ${EndIf}

  rr_climb_${uid}:
    IntOp $9 $9 + 1
    ${If} $9 > ${RELAYIUM_MAX_CLIMB}
      Goto rr_done_${uid} ; still "bad": a path this deep is not one to guess about
    ${EndIf}

    ClearErrors
    System::Call 'kernel32::CreateFileW(w r0, i 0, i ${RELAYIUM_FILE_SHARE_ALL}, p 0, i ${RELAYIUM_OPEN_EXISTING}, i ${RELAYIUM_BACKUP_SEMANTICS}, p 0) p .r2 ?e'
    Pop $3

    ${If} $2 = -1
    ${OrIf} $2 = 0
      ; Distinguish "is not there" from "is there and I may not look". Treating
      ; access-denied as absent would climb straight past a real alias, which is
      ; the same defect as trusting the lexical form.
      ${If} $3 <> ${RELAYIUM_ERROR_FILE_NOT_FOUND}
      ${AndIf} $3 <> ${RELAYIUM_ERROR_PATH_NOT_FOUND}
        Goto rr_done_${uid} ; ERROR_ACCESS_DENIED and everything else: refuse
      ${EndIf}

      ; Split off the last component and try the parent.
      StrLen $3 $0
      IntOp $3 $3 - 1
      rr_find_sep_${uid}:
        ${If} $3 < 0
          Goto rr_done_${uid} ; no separator left and nothing existed: refuse
        ${EndIf}
        StrCpy $4 $0 1 $3
        ${If} $4 == "\"
          Goto rr_split_${uid}
        ${EndIf}
        IntOp $3 $3 - 1
        Goto rr_find_sep_${uid}

      rr_split_${uid}:
        StrCpy $1 $0 $3        ; parent, without its trailing separator
        IntOp $4 $3 + 1
        StrCpy $4 $0 "" $4     ; leaf
        ${If} $1 == ""
          Goto rr_done_${uid}
        ${EndIf}
        ; "C:" is the current directory on C:, not the root. Make it the root.
        StrLen $3 $1
        ${If} $3 == 2
          StrCpy $3 $1 1 1
          ${If} $3 == ":"
            StrCpy $1 "$1\"
          ${EndIf}
        ${EndIf}
        ${If} $1 == $0
          Goto rr_done_${uid} ; no progress; refuse rather than spin
        ${EndIf}
        ; Bound BEFORE concatenating. `StrCpy` writes into a fixed
        ; NSIS_MAX_STRLEN buffer and truncates silently, so measuring the
        ; RESULT cannot detect overflow — by then the evidence is gone.
        StrLen $3 $4
        StrLen $2 $5
        IntOp $3 $3 + $2
        IntOp $3 $3 + 1        ; the separator
        ; NSIS_MAX_STRLEN here, not the capacity: this is a computed sum over
        ; the real component lengths, so a result of exactly the capacity still
        ; fits. Only the measured-variable tests above must use the capacity.
        ${If} $3 >= ${NSIS_MAX_STRLEN}
          StrCpy $2 0
          Goto rr_done_${uid}
        ${EndIf}
        StrCpy $5 "\$4$5"
        StrCpy $0 $1
        Goto rr_climb_${uid}
    ${EndIf}

    ; Handle is open. From here there is exactly ONE CloseHandle on every path
    ; out, immediately after the query — no early return may skip or repeat it.
    System::Call 'kernel32::GetFinalPathNameByHandleW(p r2, w .r1, i ${NSIS_MAX_STRLEN}, i ${RELAYIUM_VOLUME_NAME_GUID}) i .r4'
    System::Call 'kernel32::CloseHandle(p r2)'
    StrCpy $2 0

    ; 0 is failure. A return >= the capacity we passed is ALSO failure: it is the
    ; required size including the terminator, and the buffer does not hold a
    ; path. Neither may be treated as a short answer to compare.
    ${If} $4 = 0
      Goto rr_done_${uid}
    ${EndIf}
    ${If} $4 >= ${NSIS_MAX_STRLEN}
      Goto rr_done_${uid}
    ${EndIf}

    ; Re-attach the part that did not exist. It cannot contain an alias: a path
    ; component that does not exist cannot be a junction or a mount point.
    ${If} $5 != ""
      StrCpy $3 $1 "" -1
      ${If} $3 == "\"
        StrCpy $1 $1 -1   ; volume root already ends in a separator
      ${EndIf}
    ${EndIf}

    ; Again, measured before the join and not after it.
    StrLen $3 $1
    StrLen $2 $5
    IntOp $3 $3 + $2
    StrCpy $2 0
    ${If} $3 >= ${NSIS_MAX_STRLEN}
      Goto rr_done_${uid}
    ${EndIf}

    StrCpy $R7 "$1$5"
    StrCpy $R6 "ok"

  rr_done_${uid}:
  Pop $9
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; $R9 = "1" when ${candidate} collides with ${private}: equal, enclosing, or
; enclosed by. Both must already be in the same canonical namespace.
;
; The enclosed-by direction is refused too: program files inside the private
; data directory means an uninstall walks that tree.
;
; Comparisons are NSIS's default case-insensitive ones, correct for NTFS.
!macro RelayiumCollides candidate private
  Push $4
  Push $5
  Push $6

  StrCpy $4 "${candidate}"
  StrCpy $5 "${private}"

  StrCpy $6 $4 "" -1
  ${If} $6 == "\"
    StrCpy $4 $4 -1
  ${EndIf}
  StrCpy $6 $5 "" -1
  ${If} $6 == "\"
    StrCpy $5 $5 -1
  ${EndIf}

  ${If} $4 == $5
    StrCpy $R9 "1"
  ${Else}
    ; Does the candidate enclose the private directory?
    StrLen $6 $4
    Push $4
    Push $5
    StrCpy $5 $5 $6
    ${If} $5 == $4
      Pop $5
      Push $5
      StrLen $6 $4
      StrCpy $4 $5 1 $6
      ${If} $4 == "\"
        StrCpy $R9 "1"
      ${EndIf}
    ${EndIf}
    Pop $5
    Pop $4

    ${If} $R9 == "0"
      StrLen $6 $5
      Push $4
      StrCpy $4 $4 $6
      ${If} $4 == $5
        Pop $4
        Push $4
        StrLen $6 $5
        StrCpy $4 $4 1 $6
        ${If} $4 == "\"
          StrCpy $R9 "1"
        ${EndIf}
      ${EndIf}
      Pop $4
    ${EndIf}
  ${EndIf}

  Pop $6
  Pop $5
  Pop $4
!macroend

; In: $R8 = destination. Out: $R9 = "0" permit, "1" collides, "2" unverifiable,
; "3" network.
;
; Both sides are resolved on EVERY call. The private directory is deliberately
; not cached across calls: a cached answer is a staleness claim, and the whole
; point of this macro is that a path's meaning is a property of the filesystem
; at the moment it is asked, not of its spelling.
!macro RelayiumRejectsDestination
  Push $R6
  Push $R7
  Push $6 ; resolved destination
  Push $7 ; resolved private directory

  StrCpy $R9 "0"

  !insertmacro RelayiumResolve dest
  ${If} $R6 == "net"
    StrCpy $R9 "3"
    Goto rd_done
  ${EndIf}
  ${If} $R6 != "ok"
    StrCpy $R9 "2"
    Goto rd_done
  ${EndIf}
  StrCpy $6 $R7

  Push $R8
  StrCpy $R8 "$LOCALAPPDATA\${RELAYIUM_PRIVATE_DIR_NAME}"
  !insertmacro RelayiumResolve priv
  Pop $R8
  ${If} $R6 != "ok"
    ; The destination resolved but the directory being protected did not. There
    ; is nothing to compare against, and permitting would be a guess.
    StrCpy $R9 "2"
    Goto rd_done
  ${EndIf}
  StrCpy $7 $R7

  StrCpy $R9 "0"
  !insertmacro RelayiumCollides $6 $7

  rd_done:
  Pop $7
  Pop $6
  Pop $R7
  Pop $R6
!macroend

; Both refusal texts exist in English and Simplified Chinese, Relayium's
; maintained product languages. `$LANGUAGE` is the installer's LCID; 2052 is
; zh-Hans.
!macro RelayiumRefusalMessage
  ${If} $R9 == "1"
    ${If} $LANGUAGE == 2052
      MessageBox MB_ICONSTOP|MB_OK "无法将 Relayium 安装到 $INSTDIR。$\r$\n$\r$\n该位置存放着 Relayium 为此 Windows 账户保存的私有数据，安装到这里会在下次更新或卸载时将其删除。$\r$\n$\r$\n请选择其他文件夹。"
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Relayium cannot be installed into $INSTDIR.$\r$\n$\r$\nThat location holds Relayium's private data for this Windows account, and installing there would delete it on the next update or uninstall.$\r$\n$\r$\nChoose a different folder."
    ${EndIf}
  ${ElseIf} $R9 == "3"
    ${If} $LANGUAGE == 2052
      MessageBox MB_ICONSTOP|MB_OK "Relayium 不支持安装到网络位置。$\r$\n$\r$\n请选择本机磁盘上的文件夹。"
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Relayium cannot be installed to a network location.$\r$\n$\r$\nChoose a folder on a local drive."
    ${EndIf}
  ${Else}
    ${If} $LANGUAGE == 2052
      MessageBox MB_ICONSTOP|MB_OK "Relayium 无法确认安装位置 $INSTDIR。$\r$\n$\r$\n为避免误删此 Windows 账户的私有数据，安装已停止。$\r$\n$\r$\n请选择其他文件夹。"
    ${Else}
      MessageBox MB_ICONSTOP|MB_OK "Relayium could not verify the destination $INSTDIR.$\r$\n$\r$\nInstallation stopped rather than risk deleting this Windows account's private data.$\r$\n$\r$\nChoose a different folder."
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  Push $R8
  Push $R9
  StrCpy $R8 $INSTDIR
  !insertmacro RelayiumRejectsDestination
  ${If} $R9 != "0"
    ; Interactive runs land here too, for the destination the run starts with —
    ; the directory page should not open already pointing somewhere that is
    ; going to be refused.
    ${IfNot} ${Silent}
      !insertmacro RelayiumRefusalMessage
    ${EndIf}
    ${If} $R9 == "1"
      SetErrorLevel ${RELAYIUM_ERR_COLLIDES}
    ${Else}
      SetErrorLevel ${RELAYIUM_ERR_UNVERIFIABLE}
    ${EndIf}
    Pop $R9
    Pop $R8
    Quit
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend

; Every change of $INSTDIR on the directory page. `Abort` disables Next; no
; dialog, because this fires per keystroke.
;
; No verdict cache. An earlier revision remembered the last path and its answer,
; and justified it by claiming the install section was gated too. It is not:
; grepping the pinned templates, the only hooks this file defines are
; `customInit` (inside `.onInit`) and this function. `customInstall` — the hook
; that runs inside the install section — is inserted at `installSection.nsh:82`,
; AFTER `uninstallOldVersion` at line 53 and after `installApplicationFiles` at
; line 65, so it could not protect anything even if it were used. The claim was
; false and the cache it justified contradicted the re-resolve contract, so both
; are gone: every call resolves both sides afresh.
;
; The earliest hook that runs before both the old-version uninstall and
; extraction is `customCheckAppRunning`, reached from `CHECK_APP_RUNNING`
; (`include/allowOnlyOneInstallerInstance.nsh:37`), which `installSection.nsh`
; inserts at line 33. It is deliberately NOT used, and the reasons are recorded
; here because the hook looks additive and is not:
;
;   * It REPLACES rather than extends. Defining it takes the `!else` branch away
;     from `IS_POWERSHELL_AVAILABLE` + `_CHECK_APP_RUNNING`
;     (`allowOnlyOneInstallerInstance.nsh:37-42`), so the protection against
;     installing over a running Relayium would be silently dropped unless this
;     file re-inserted both itself.
;   * Defining it also suppresses declarations that macro needs. Lines 5-8 of
;     that file include `getProcessInfo.nsh` and declare `Var pid` only
;     `!ifmacrondef customCheckAppRunning`, and `_CHECK_APP_RUNNING` uses both
;     `$pid` and `${GetProcessInfo}`. Re-inserting it without also re-supplying
;     those does not compile.
;   * **`uninstaller.nsh:2` inserts `CHECK_APP_RUNNING` too.** A destination
;     collision check wired into this hook would therefore run during UNINSTALL
;     and could refuse it. Refusing to uninstall is a worse failure than the one
;     this file exists to prevent, so any use of the hook would have to branch on
;     the installer/`BUILD_UNINSTALLER` path as well.
;
; Taking ownership of the app-running check, its two suppressed declarations and
; an uninstaller branch — to NARROW rather than close a window — is not a
; proportionate trade. The residual below is stated instead.
;
; ## What is genuinely covered
;
; `customInit` validates the destination the run starts with, including `/D=`.
; This function validates every destination chosen on the directory page, and
; refuses to let the user advance past a bad one. Between the final check and
; extraction there is a TOCTOU window: an alias created in it is not caught. The
; attacker must already be the same Windows account. That residual is real and
; is not argued away.

Function .onVerifyInstDir
  Push $R8
  Push $R9

  StrCpy $R8 $INSTDIR
  !insertmacro RelayiumRejectsDestination

  ${If} $R9 != "0"
    Pop $R9
    Pop $R8
    Abort
  ${EndIf}
  Pop $R9
  Pop $R8
FunctionEnd

; ---------------------------------------------------------------------------
; `relayium://` registration.
;
; ## Why this is here and not in electron-builder
;
; `electron-builder.yml` has a `protocols:` block, and until run 102806132639 a
; comment in this project claimed the installer owned the association because of
; it. That was false. `protocols` is consumed only by `LinuxTargetHelper` and
; `AppxTarget` in the pinned app-builder-lib; **the NSIS target does not read it
; at all** (`grep -rn protocol templates/nsis/` and `out/targets/nsis/` return
; nothing). The installer registered nothing.
;
; What actually registered the scheme was `main.ts` calling
; `setAsDefaultProtocolClient` at runtime, on first launch. That produced exactly
; the three failures the first Windows job found: the key was absent before the
; app had ever run, and the uninstaller — which knew nothing about a key it did
; not write — left it behind pointing at a deleted executable.
;
; So registration moves here, where the uninstaller can also remove it.
;
; ## HKCU only
;
; Written to `HKCU` literally rather than `SHELL_CONTEXT`. This is a per-user
; install and a per-user association; hard-coding the hive means a later change
; to `perMachine` cannot silently turn this into a machine-wide association.
; Nothing here writes `HKLM`.

; ## `relayium://` registration
;
; The NSIS target does not read `electron-builder.yml`'s `protocols:` key — the
; pinned app-builder-lib consumes it only in its Linux and Appx targets. So this
; file is the sole writer of the association, and the sole remover.
;
; `${APP_EXECUTABLE_FILENAME}` is not defined where this file is PARSED
; (electron-builder emits it into the common header, before `common.nsh`), but a
; macro body is not parsed until it is inserted, and both insertion points are
; after that include. An undefined `${...}` is not an NSIS error — it survives as
; a literal — so each macro asserts the define at its own expansion rather than
; trusting it.

!define RELAYIUM_SCHEME "relayium"
!define RELAYIUM_SCHEME_KEY "Software\Classes\${RELAYIUM_SCHEME}"
!define RELAYIUM_SCHEME_CMD_KEY "${RELAYIUM_SCHEME_KEY}\shell\open\command"

!macro customInstall
  !ifndef APP_EXECUTABLE_FILENAME
    !error "APP_EXECUTABLE_FILENAME undefined at customInstall: the registration would write a literal placeholder"
  !endif
  ; After extraction: the value must name an executable that is on disk.
  DetailPrint "Registering ${RELAYIUM_SCHEME}:// for this user"
  WriteRegStr HKCU "${RELAYIUM_SCHEME_KEY}" "" "URL:Relayium Protocol"
  WriteRegStr HKCU "${RELAYIUM_SCHEME_KEY}" "URL Protocol" ""
  WriteRegStr HKCU "${RELAYIUM_SCHEME_KEY}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  ; Quoted path, then the URL as ONE quoted argument. Unquoted, a destination
  ; containing a space would hand the app a truncated path as argv[1].
  WriteRegStr HKCU "${RELAYIUM_SCHEME_CMD_KEY}" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  !ifndef APP_EXECUTABLE_FILENAME
    !error "APP_EXECUTABLE_FILENAME undefined at customUnInstall: the ownership test would compare a literal placeholder"
  !endif
  ; Runs before the installed files are removed, so `$INSTDIR` still spells the
  ; executable this installation registered.
  ;
  ; EXACT match against the one command this installer writes. An earlier version
  ; accepted any quoted path under `$INSTDIR\`, which also accepts a different
  ; program dropped in that directory and accepts `$INSTDIR\..\other.exe` —
  ; a prefix test is not an identity test. Since this file is the only writer,
  ; the exact string is available and is what ownership means.
  ;
  ; Conditional because an association is a shared, single-valued resource: if
  ; the user has since pointed `relayium://` at another program, that
  ; registration is not ours to delete.
  Push $0
  ReadRegStr $0 HKCU "${RELAYIUM_SCHEME_CMD_KEY}" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "${RELAYIUM_SCHEME_KEY}"
  ${Else}
    DetailPrint "Leaving ${RELAYIUM_SCHEME}:// registered: it does not name this installation"
  ${EndIf}
  Pop $0
!macroend
