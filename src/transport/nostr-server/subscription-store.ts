/**
 * Tracks resource subscriptions independently from transient request routes.
 */
export class SubscriptionStore {
  private readonly uriToClients = new Map<string, Set<string>>();
  private readonly clientToUris = new Map<string, Set<string>>();

  public subscribe(clientPubkey: string, uri: string): void {
    let clients = this.uriToClients.get(uri);
    if (!clients) {
      clients = new Set();
      this.uriToClients.set(uri, clients);
    }
    clients.add(clientPubkey);

    let uris = this.clientToUris.get(clientPubkey);
    if (!uris) {
      uris = new Set();
      this.clientToUris.set(clientPubkey, uris);
    }
    uris.add(uri);
  }

  public unsubscribe(clientPubkey: string, uri: string): void {
    const clients = this.uriToClients.get(uri);
    clients?.delete(clientPubkey);
    if (clients?.size === 0) {
      this.uriToClients.delete(uri);
    }

    const uris = this.clientToUris.get(clientPubkey);
    uris?.delete(uri);
    if (uris?.size === 0) {
      this.clientToUris.delete(clientPubkey);
    }
  }

  public removeForClient(clientPubkey: string): void {
    const uris = this.clientToUris.get(clientPubkey);
    if (!uris) {
      return;
    }
    for (const uri of uris) {
      const clients = this.uriToClients.get(uri);
      clients?.delete(clientPubkey);
      if (clients?.size === 0) {
        this.uriToClients.delete(uri);
      }
    }
    this.clientToUris.delete(clientPubkey);
  }

  public getSubscribers(uri: string): ReadonlySet<string> {
    // Do not expose the set held by the index: callers iterate this while
    // sessions can be evicted, and a cast at a call site must not be able to
    // mutate subscription state.
    return new Set(this.uriToClients.get(uri));
  }

  public clear(): void {
    this.uriToClients.clear();
    this.clientToUris.clear();
  }
}
