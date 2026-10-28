function originOf(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
  } catch {}
}

export function isAllowedRequestOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const normalized = originOf(origin);
  if (!normalized) return false;
  const allowed = new Set([
    originOf(request.url),
    originOf(process.env.APP_BASE_URL),
    originOf(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined),
    originOf(process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined),
  ].filter(Boolean));
  return allowed.has(normalized);
}
