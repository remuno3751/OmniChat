import { describe, expect, it } from "vitest";
import {
  isGitInternal,
  isSecretPath,
  normalizePath,
  resolveInWorkspace,
  type RealpathFn,
} from "../src/guard/paths";

/** Fake realpath: known paths resolve to their mapped target, others are ENOENT. */
function fakeFs(map: Record<string, string>, errors: Record<string, string> = {}): RealpathFn {
  return async (p: string) => {
    if (Object.prototype.hasOwnProperty.call(errors, p)) {
      throw Object.assign(new Error(errors[p]), { code: errors[p] });
    }
    if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  };
}

const POSIX_ROOT = "/ws/proj";
const posixFs = fakeFs({
  "/ws/proj": "/ws/proj",
  "/ws/proj/src": "/ws/proj/src",
  "/ws/proj/link": "/etc", // symlink escaping the root
  "/ws/proj/alias": "/ws/proj/src", // symlink staying inside the root
  "/ws/proj/locked": "/ws/proj/locked",
}, { "/ws/proj/locked/x": "EACCES" });

describe("normalizePath", () => {
  it("converts backslashes and resolves dot segments", () => {
    expect(normalizePath("a\\b\\..\\c")).toBe("a/c");
    expect(normalizePath("/a/b/../c/./d/")).toBe("/a/c/d");
    expect(normalizePath("../a")).toBe("../a");
    expect(normalizePath("/..")).toBe("/");
  });

  it("keeps drive and UNC prefixes", () => {
    expect(normalizePath("C:\\Proj\\src")).toBe("C:/Proj/src");
    expect(normalizePath("//srv/share/x/../y")).toBe("//srv/share/y");
  });
});

describe("resolveInWorkspace (POSIX root)", () => {
  it("accepts relative and absolute paths inside the root", async () => {
    expect(await resolveInWorkspace(POSIX_ROOT, "src/a.ts", posixFs)).toEqual({
      ok: true,
      abs: "/ws/proj/src/a.ts",
    });
    expect(await resolveInWorkspace(POSIX_ROOT, "/ws/proj/src/a.ts", posixFs)).toEqual({
      ok: true,
      abs: "/ws/proj/src/a.ts",
    });
    expect(await resolveInWorkspace(POSIX_ROOT, ".", posixFs)).toEqual({ ok: true, abs: "/ws/proj" });
  });

  it("accepts a new file under an existing directory", async () => {
    expect(await resolveInWorkspace(POSIX_ROOT, "src/new/deep.ts", posixFs)).toEqual({
      ok: true,
      abs: "/ws/proj/src/new/deep.ts",
    });
  });

  it("refuses .. escapes and absolute paths outside the root", async () => {
    for (const p of ["../x", "src/../../x", "/etc/passwd", "/ws/proj/../other/x", "/ws/proj2/x"]) {
      const r = await resolveInWorkspace(POSIX_ROOT, p, posixFs);
      expect(r, p).toMatchObject({ ok: false, reason: "outside_workspace" });
    }
  });

  it("refuses home-relative forms", async () => {
    for (const p of ["~/.bashrc", "$HOME/x", "%USERPROFILE%\\x"]) {
      expect(await resolveInWorkspace(POSIX_ROOT, p, posixFs)).toMatchObject({
        ok: false,
        reason: "outside_workspace",
      });
    }
  });

  it("refuses Windows drive and UNC paths on a POSIX host", async () => {
    for (const p of ["C:\\Windows\\system32", "D:/x", "\\\\server\\share\\x", "//srv/share/x"]) {
      expect(await resolveInWorkspace(POSIX_ROOT, p, posixFs)).toMatchObject({
        ok: false,
        reason: "outside_workspace",
      });
    }
  });

  it("compares case-sensitively for POSIX roots", async () => {
    const r = await resolveInWorkspace("/ws/Proj", "/ws/proj/a", fakeFs({ "/ws/Proj": "/ws/Proj" }));
    expect(r).toMatchObject({ ok: false, reason: "outside_workspace" });
  });

  it("refuses NUL and control characters", async () => {
    for (const p of ["a\0b", "a\nb", "a\x7fb"]) {
      expect(await resolveInWorkspace(POSIX_ROOT, p, posixFs)).toMatchObject({
        ok: false,
        reason: "invalid_args",
      });
    }
  });

  it("refuses over-long paths and components", async () => {
    const long = "a/".repeat(2100);
    expect(await resolveInWorkspace(POSIX_ROOT, long, posixFs)).toMatchObject({
      ok: false,
      reason: "invalid_args",
    });
    const longComponent = "x".repeat(256);
    expect(await resolveInWorkspace(POSIX_ROOT, longComponent, posixFs)).toMatchObject({
      ok: false,
      reason: "invalid_args",
    });
  });

  it("refuses a relative workspace root", async () => {
    expect(await resolveInWorkspace("ws/proj", "a.ts", posixFs)).toMatchObject({
      ok: false,
      reason: "invalid_args",
    });
  });

  it("refuses a symlink whose target lies outside the root", async () => {
    const r = await resolveInWorkspace(POSIX_ROOT, "link/passwd", posixFs);
    expect(r).toMatchObject({ ok: false, reason: "outside_workspace" });
    expect(await resolveInWorkspace(POSIX_ROOT, "link/newdir/x", posixFs)).toMatchObject({
      ok: false,
      reason: "outside_workspace",
    });
  });

  it("accepts a symlink whose target stays inside the root", async () => {
    expect(await resolveInWorkspace(POSIX_ROOT, "alias/a.ts", posixFs)).toEqual({
      ok: true,
      abs: "/ws/proj/alias/a.ts",
    });
  });

  it("resolves a symlinked workspace root before comparing", async () => {
    const fs = fakeFs({ "/ws/link-root": "/real/proj", "/real/proj": "/real/proj" });
    expect(await resolveInWorkspace("/ws/link-root", "a.ts", fs)).toEqual({
      ok: true,
      abs: "/ws/link-root/a.ts",
    });
  });

  it("reports io_error for non-missing realpath failures", async () => {
    expect(await resolveInWorkspace(POSIX_ROOT, "locked/x", posixFs)).toMatchObject({
      ok: false,
      reason: "io_error",
    });
  });
});

describe("resolveInWorkspace (Windows-style root)", () => {
  const winFs = fakeFs({
    "C:/Proj": "C:/Proj",
    "C:/Proj/src": "C:/Proj/src",
    "C:/Proj/link": "D:/secret",
  });

  it("accepts backslash and mixed-case paths inside the root", async () => {
    expect(await resolveInWorkspace("C:\\Proj", "src\\a.ts", winFs)).toEqual({
      ok: true,
      abs: "C:/Proj/src/a.ts",
    });
    expect(await resolveInWorkspace("C:\\Proj", "c:/proj/x.ts", winFs)).toEqual({
      ok: true,
      abs: "c:/proj/x.ts",
    });
  });

  it("refuses other drives and POSIX paths", async () => {
    expect(await resolveInWorkspace("C:\\Proj", "D:/x", winFs)).toMatchObject({
      ok: false,
      reason: "outside_workspace",
    });
    expect(await resolveInWorkspace("C:\\Proj", "/ws/x", winFs)).toMatchObject({
      ok: false,
      reason: "outside_workspace",
    });
  });

  it("refuses a symlink escape", async () => {
    expect(await resolveInWorkspace("C:\\Proj", "link/x", winFs)).toMatchObject({
      ok: false,
      reason: "outside_workspace",
    });
  });
});

describe("isSecretPath", () => {
  it.each([
    ".env",
    ".env.local",
    "config/.env.production",
    "id_rsa",
    "keys/id_ed25519.pub",
    "certs/server.pem",
    "x.key",
    "a/.ssh/config",
    ".ssh/known_hosts",
    ".npmrc",
    ".docker/config.json",
    "src\\.env",
  ])("flags %s", (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([".env.example", ".env.sample", ".env.template", "src/env.ts", "sshconfig", "notes/keys.md"])(
    "allows %s",
    (p) => {
      expect(isSecretPath(p)).toBe(false);
    },
  );
});

describe("isGitInternal", () => {
  it.each([".git", ".git/config", "sub/.git/HEAD", "sub\\.git\\index", "vendor/lib/.git"])(
    "flags %s",
    (p) => {
      expect(isGitInternal(p)).toBe(true);
    },
  );

  it.each([".github/workflows/ci.yml", ".gitignore", "a/.gitfoo/x", "src/git.ts"])(
    "allows %s",
    (p) => {
      expect(isGitInternal(p)).toBe(false);
    },
  );
});
