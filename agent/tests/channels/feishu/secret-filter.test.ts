import { describe, it, expect } from "vitest";
import { filterSecrets } from "../../../src/channels/feishu/secret-filter.js";

describe("filterSecrets", () => {
  it("redacts generic key=value secrets, keeping the key name", () => {
    const input = "password=abc123def456ghij";
    const result = filterSecrets(input);
    expect(result).toContain("password=");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abc123def456ghij");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890abcdef";
    const result = filterSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("abcdef1234567890abcdef");
  });

  it("redacts AWS-style access keys", () => {
    const input = "Found key: AKIAIOSFODNN7EXAMPLE";
    const result = filterSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts GitHub tokens (ghp_ prefix)", () => {
    const input = "token: ghp_xxxxxxxxxxxxxxxxxxxx";
    const result = filterSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_xxxxxxxxxxxxxxxxxxxx");
  });

  it("redacts SSH private key blocks", () => {
    const input = `Here is a key:
-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJla
-----END RSA PRIVATE KEY-----
end of key`;
    const result = filterSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("MIIBogIBAAJBALRiMLAHudeSA");
  });

  it("redacts connection string passwords, keeping protocol prefix and host", () => {
    const input = "postgres://user:secretpass@db.host.com/mydb";
    const result = filterSecrets(input);
    // The regex replaces ://user:pass@ with :[REDACTED]@, preserving protocol prefix and host
    expect(result).toMatch(/^postgres:/);
    expect(result).toContain("[REDACTED]");
    expect(result).toContain("@db.host.com/mydb");
    expect(result).not.toContain("secretpass");
  });

  it("returns normal text unchanged when no secrets present", () => {
    const input = "This is a normal message about code review.";
    expect(filterSecrets(input)).toBe(input);
  });

  it("redacts multiple secrets in the same text", () => {
    const input = [
      "password=super_secret_value_123",
      "Bearer longtokenvalue1234567890abc",
      "postgres://admin:dbpass123@localhost/app",
    ].join("\n");
    const result = filterSecrets(input);

    // All three secrets should be redacted
    expect(result).not.toContain("super_secret_value_123");
    expect(result).not.toContain("longtokenvalue1234567890abc");
    expect(result).not.toContain("dbpass123");

    // Keys/structure preserved
    expect(result).toContain("password=");
    expect(result).toContain("@localhost/app");
  });

  it("handles repeated calls correctly (regex lastIndex reset)", () => {
    const input1 = "token=aaaa1234567890bbbb";
    const input2 = "secret=cccc1234567890dddd";

    const result1 = filterSecrets(input1);
    const result2 = filterSecrets(input2);

    expect(result1).toContain("[REDACTED]");
    expect(result1).not.toContain("aaaa1234567890bbbb");
    expect(result2).toContain("[REDACTED]");
    expect(result2).not.toContain("cccc1234567890dddd");
  });
});
