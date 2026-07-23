const redactPrefix = (path: string, prefix: string): string => {
  if (!path.startsWith(prefix)) return path;
  const suffix = path.slice(prefix.length);
  const slash = suffix.indexOf("/");
  return `${prefix}[redacted]${slash < 0 ? "" : suffix.slice(slash)}`;
};

/** Share and transfer slugs are bearer credentials and never belong in logs. */
export const redactBearerPath = (path: string): string => {
  for (const prefix of ["/api/v1/s/", "/api/v1/t/", "/s/", "/t/"]) {
    const redacted = redactPrefix(path, prefix);
    if (redacted !== path) return redacted;
  }
  return path;
};
