/** Decides whether an updated resource is a sub-resource of a subscribed URI. */
export type ResourceSubscriptionMatcher = (
  subscribedUri: string,
  updatedUri: string,
) => boolean;

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

  /** Finds subscribers to an update, including server-defined sub-resources. */
  public getSubscribersForUpdate(
    updatedUri: string,
    matchesSubResource?: ResourceSubscriptionMatcher,
  ): ReadonlySet<string> {
    const subscribers = new Set(this.uriToClients.get(updatedUri));
    if (matchesSubResource) {
      for (const [subscribedUri, clients] of this.uriToClients) {
        if (
          subscribedUri !== updatedUri &&
          matchesSubResource(subscribedUri, updatedUri)
        ) {
          for (const clientPubkey of clients) {
            subscribers.add(clientPubkey);
          }
        }
      }
    }
    return subscribers;
  }

  public clear(): void {
    this.uriToClients.clear();
    this.clientToUris.clear();
  }
}
