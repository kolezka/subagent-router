const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}

export async function modelAlias(id: string): Promise<string> {
  return `m-${await sha256(id)}`;
}

export async function sourceFingerprint(sourceId: string, gatewayUrl: string, modelsUrl: string): Promise<string> {
  return sha256(JSON.stringify([sourceId, gatewayUrl, modelsUrl]));
}
