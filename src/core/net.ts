/**
 * Which address this machine answers on, from the reader's point of view.
 *
 * Loopback is useless here: the reader is a different machine on the same
 * Wi-Fi, so anything we hand it — the kosync URL we push into its settings, the
 * one printed for typing by hand — has to be an address that leaves this host.
 * "We could not work it out" is a real state the UI has to be able to show,
 * hence the null rather than a 127.0.0.1 that would look like it worked.
 */
export function lanAddress(): string | null {
  let fallback: string | null = null;
  try {
    for (const iface of Deno.networkInterfaces()) {
      if (iface.family !== "IPv4") continue;
      const ip = iface.address;
      if (ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return ip;
      fallback ??= ip;
    }
  } catch {
    return null;
  }
  return fallback;
}

/** Every address that reaches this machine, loopback included. */
export function localAddresses(): Set<string> {
  const out = new Set(["127.0.0.1", "localhost", "::1"]);
  try {
    for (const iface of Deno.networkInterfaces()) out.add(iface.address);
  } catch { /* no permission — the set is still correct, just shorter */ }
  return out;
}

/**
 * Whether a URL points back at us. Used before overwriting a sync server the
 * user configured on the reader themselves: pointing it at this machine by
 * hand, at whatever address it had at the time, must not read as a conflict.
 */
export function isLocalUrl(url: string): boolean {
  try {
    return localAddresses().has(new URL(url).hostname);
  } catch {
    return false;
  }
}
