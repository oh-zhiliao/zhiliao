// Patterns that look like secrets/tokens/passwords in code
const SECRET_PATTERNS = [
  // Generic key=value patterns with long alphanumeric values
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9+/=_\-.]{16,}["']?/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9+/=_\-.]{20,}/g,
  // AWS-style keys
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  // GitHub/GitLab tokens
  /(?:ghp|gho|ghu|ghs|ghr|glpat)[_-][A-Za-z0-9]{20,}/g,
  // Generic long hex strings that look like secrets (32+ chars)
  /(?:secret|token|key|password|credential)["'`]*\s*[:=]\s*["'`]?[0-9a-f]{32,}["'`]?/gi,
  // SSH private key blocks
  /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
  // Connection strings with passwords
  /(?:mysql|postgres|mongodb|redis|amqp):\/\/[^:\s]+:[^@\s]+@/gi,
];

const REDACTED = "[REDACTED]";

export function filterSecrets(text: string, extraPatterns: RegExp[] = []): string {
  let result = text;
  const allPatterns = extraPatterns.length > 0
    ? [...SECRET_PATTERNS, ...extraPatterns]
    : SECRET_PATTERNS;
  for (const pattern of allPatterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      // For connection strings, keep the protocol and host, redact password
      if (/^(?:mysql|postgres|mongodb|redis|amqp):\/\//i.test(match)) {
        return match.replace(/:([^@]+)@/, `:${REDACTED}@`);
      }
      // For key=value, keep the key name, redact the value
      const kvMatch = match.match(/^(.+?[:=]\s*["'`]?)/);
      if (kvMatch) {
        return kvMatch[1] + REDACTED;
      }
      return REDACTED;
    });
  }
  return result;
}
