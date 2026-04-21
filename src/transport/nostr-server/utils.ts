/**
 * Returns true when the relay URL is local-only and should not trigger
 * default public bootstrap publication by itself.
 */
export function isLocalRelayUrl(relayUrl: string): boolean {
  if (relayUrl.startsWith('memory://')) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}

/**
 * Returns true when the relay URL uses a websocket transport.
 */
export function isWebsocketRelayUrl(relayUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return false;
  }

  return url.protocol === 'ws:' || url.protocol === 'wss:';
}
