import {NextResponse} from 'next/server';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Only Firebase web configuration is public. Never return Admin credentials.
  const fields = {
    apiKey: 'NEXT_PUBLIC_FIREBASE_API_KEY',
    authDomain: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    projectId: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    appId: 'NEXT_PUBLIC_FIREBASE_APP_ID',
  };
  const config = Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, process.env[name]?.trim() || '']));
  const headers = {'Cache-Control': 'no-store'};
  if (Object.values(config).some(value => !value)) {
    return NextResponse.json({error: 'Google sign-in is not configured. Contact the workspace administrator.'}, {status: 503, headers});
  }
  return NextResponse.json(config, {headers});
}
