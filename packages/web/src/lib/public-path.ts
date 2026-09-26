const PREFIXES = ["/login", "/setup", "/invite", "/reset", "/s", "/t"];

export const isPublicPath = (pathname: string): boolean =>
  PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
