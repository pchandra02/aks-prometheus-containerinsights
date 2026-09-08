const SECRET_PATTERN = /(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|aws_secret_access_key\s*[=:]\s*[^\s,]+|aws_session_token\s*[=:]\s*[^\s,]+|authorization\s*[=:]\s*[^\n]+|x-amz-security-token\s*[=:]\s*[^\s,]+)/gi;

export function sanitize(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(/\b(token|secret|password)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string") return sanitize(item);
    return item;
  }, 2);
}
