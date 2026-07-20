import { describe, it, expect } from "vitest";
import { STREAM_ROUTE, streamURL, parseStreamPath, contentDisposition } from "./sw-stream";

describe("STREAM_ROUTE", () => {
  it("is a dunder-namespaced prefix that cannot collide with a real route", () => {
    expect(STREAM_ROUTE).toBe("/__stream__/");
    expect(STREAM_ROUTE.startsWith("/")).toBe(true);
    expect(STREAM_ROUTE.endsWith("/")).toBe(true);
  });
});

describe("streamURL", () => {
  it("puts the token and the filename in the path", () => {
    expect(streamURL("abc123", "report.pdf")).toBe("/__stream__/abc123/report.pdf");
  });

  it("percent-encodes non-ASCII filenames", () => {
    expect(streamURL("t-1_2", "图 片.svg")).toBe("/__stream__/t-1_2/%E5%9B%BE%20%E7%89%87.svg");
  });

  it("encodes separators so the filename cannot forge extra path segments or a query", () => {
    expect(streamURL("t", "a/b?c#d.txt")).toBe("/__stream__/t/a%2Fb%3Fc%23d.txt");
    expect(streamURL("t", "../../etc/passwd")).toBe("/__stream__/t/..%2F..%2Fetc%2Fpasswd");
  });

  it("falls back to a placeholder segment for an empty filename", () => {
    expect(streamURL("t", "")).toBe("/__stream__/t/download");
  });

  it("rejects a token that would not survive parseStreamPath", () => {
    expect(() => streamURL("", "f.txt")).toThrow(/token/i);
    expect(() => streamURL("../x", "f.txt")).toThrow(/token/i);
    expect(() => streamURL("a/b", "f.txt")).toThrow(/token/i);
    expect(() => streamURL("a".repeat(65), "f.txt")).toThrow(/token/i);
  });

  it("round-trips through parseStreamPath", () => {
    const url = streamURL("Tok_en-09", "图 片.svg");
    expect(parseStreamPath(url)).toEqual({ token: "Tok_en-09" });
  });
});

describe("parseStreamPath", () => {
  it("extracts the token from a well-formed path", () => {
    expect(parseStreamPath("/__stream__/abc123/report.pdf")).toEqual({ token: "abc123" });
    expect(parseStreamPath("/__stream__/A-b_9/%E5%9B%BE.svg")).toEqual({ token: "A-b_9" });
  });

  it("rejects paths outside the stream route", () => {
    expect(parseStreamPath("")).toBeNull();
    expect(parseStreamPath("/")).toBeNull();
    expect(parseStreamPath("/d/abc")).toBeNull();
    expect(parseStreamPath("/api/files/abc/blob")).toBeNull();
    expect(parseStreamPath("/__STREAM__/abc/f.txt")).toBeNull();
    expect(parseStreamPath("__stream__/abc/f.txt")).toBeNull();
    expect(parseStreamPath("/x/__stream__/abc/f.txt")).toBeNull();
  });

  it("rejects a missing or empty token", () => {
    expect(parseStreamPath("/__stream__")).toBeNull();
    expect(parseStreamPath("/__stream__/")).toBeNull();
    expect(parseStreamPath("/__stream__//f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/abc")).toBeNull(); // filename segment missing
    expect(parseStreamPath("/__stream__/abc/")).toBeNull(); // filename segment empty
  });

  it("rejects a token with characters outside the URL-safe alphabet", () => {
    expect(parseStreamPath("/__stream__/../f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/./f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/a%2Fb/f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/a.b/f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/a b/f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/图/f.txt")).toBeNull();
    expect(parseStreamPath("/__stream__/" + "a".repeat(65) + "/f.txt")).toBeNull();
  });

  it("rejects extra path segments after the filename", () => {
    expect(parseStreamPath("/__stream__/abc/f.txt/extra")).toBeNull();
    expect(parseStreamPath("/__stream__/abc/dir/f.txt")).toBeNull();
  });
});

describe("contentDisposition", () => {
  it("emits both a quoted ASCII fallback and an RFC 5987 filename*", () => {
    expect(contentDisposition("report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("keeps a non-ASCII name in filename* and degrades the fallback to underscores", () => {
    expect(contentDisposition("图 片.svg")).toBe(
      `attachment; filename="_ _.svg"; filename*=UTF-8''%E5%9B%BE%20%E7%89%87.svg`,
    );
  });

  it("handles an all-non-ASCII name (fallback is still non-empty)", () => {
    expect(contentDisposition("你好世界")).toBe(
      `attachment; filename="____"; filename*=UTF-8''%E4%BD%A0%E5%A5%BD%E4%B8%96%E7%95%8C`,
    );
  });

  it("neutralizes a double quote so it cannot close the quoted-string", () => {
    expect(contentDisposition('a"b.txt')).toBe(
      `attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`,
    );
    // The classic escape attempt: close the quote and append a bogus parameter.
    expect(contentDisposition('x.txt"; filename="evil.exe')).toBe(
      `attachment; filename="x.txt__ filename=_evil.exe"; filename*=UTF-8''x.txt%22%3B%20filename%3D%22evil.exe`,
    );
  });

  it("neutralizes a semicolon so it cannot start a new parameter", () => {
    expect(contentDisposition("a;b.txt")).toBe(
      `attachment; filename="a_b.txt"; filename*=UTF-8''a%3Bb.txt`,
    );
  });

  it("strips CR/LF — a header-injection attempt must not survive into the value", () => {
    expect(contentDisposition("a\r\nX-Evil: 1.txt")).toBe(
      `attachment; filename="aX-Evil: 1.txt"; filename*=UTF-8''aX-Evil%3A%201.txt`,
    );
    expect(contentDisposition("ok.txt\r\n\r\n<script>alert(1)</script>")).toBe(
      `attachment; filename="ok.txt<script>alert(1)<_script>"; filename*=UTF-8''ok.txt%3Cscript%3Ealert%281%29%3C%2Fscript%3E`,
    );
    // A name that is nothing but CR/LF collapses to the placeholder, not to "".
    expect(contentDisposition("\r\n")).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });

  it("strips NUL, DEL and other control characters", () => {
    expect(contentDisposition("a\u0000b\u007fc\u0085d.txt")).toBe(
      `attachment; filename="abcd.txt"; filename*=UTF-8''abcd.txt`,
    );
  });

  it("strips a backslash so the quoted-string has no escape sequences", () => {
    expect(contentDisposition("a\\b.txt")).toBe(
      `attachment; filename="a_b.txt"; filename*=UTF-8''a%5Cb.txt`,
    );
    expect(contentDisposition("C:\\Windows\\evil.exe")).toBe(
      `attachment; filename="C:_Windows_evil.exe"; filename*=UTF-8''C%3A%5CWindows%5Cevil.exe`,
    );
  });

  it("uses the placeholder for an empty name", () => {
    expect(contentDisposition("")).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });

  it("percent-encodes the characters encodeURIComponent leaves raw but RFC 5987 forbids", () => {
    // ' ( ) * are not attr-chars; a raw ' in particular breaks the UTF-8''<value>
    // delimiter parsing. ! is a legal attr-char and stays raw.
    expect(contentDisposition("it's (a) *file*!.txt")).toBe(
      `attachment; filename="it's (a) *file*!.txt"; filename*=UTF-8''it%27s%20%28a%29%20%2Afile%2A!.txt`,
    );
  });

  it("truncates an over-long name but keeps the extension", () => {
    expect(contentDisposition("a".repeat(300) + ".txt")).toBe(
      `attachment; filename="${"a".repeat(116)}.txt"; filename*=UTF-8''${"a".repeat(116)}.txt`,
    );
  });

  it("truncates by code point, never splitting a surrogate pair", () => {
    const out = contentDisposition("😀".repeat(200) + ".png");
    expect(out).toBe(
      `attachment; filename="${"_".repeat(116)}.png"; filename*=UTF-8''${"%F0%9F%98%80".repeat(116)}.png`,
    );
    // A split pair would have made encodeURIComponent throw, or emitted U+FFFD.
    expect(out).not.toContain("%EF%BF%BD");
  });

  it("drops lone surrogates instead of throwing", () => {
    expect(contentDisposition("\ud800bad\udfff.txt")).toBe(
      `attachment; filename="bad.txt"; filename*=UTF-8''bad.txt`,
    );
  });

  it("never emits CR, LF, NUL or an unbalanced quote for any of the hostile inputs", () => {
    const hostile = [
      "",
      "\r\n",
      'a"b',
      "a;b",
      "a\r\nSet-Cookie: x=1",
      "\u0000\u0001\u001f\u007f",
      "😀".repeat(200),
      "a".repeat(1000),
      "\ud800",
      "../../etc/passwd",
    ];
    for (const name of hostile) {
      const out = contentDisposition(name);
      expect(out).toMatch(
        /^attachment; filename="[^"\\\r\n\u0000;]+"; filename\*=UTF-8''[!#$&+\-.^_`|~a-zA-Z0-9%]+$/,
      );
    }
  });
});
