export async function firebaseWebConfig(): Promise<{apiKey:string;authDomain:string;projectId:string;appId:string}> {
  const response = await fetch('/api/firebase-config', {cache: 'no-store'});
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || 'Google sign-in configuration is unavailable.');
  return config;
}
