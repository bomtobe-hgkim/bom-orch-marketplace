const bindings = new WeakMap();

/** Bind one returned in-process handle object to the exact durable authority generation. */
export function bindWorktreeAuthority(handle, authority) {
  if (handle === null || typeof handle !== 'object' || authority === null || typeof authority !== 'object') {
    return false;
  }
  bindings.set(handle, authority);
  return true;
}

/** Trusted validators use this when replacing a handle object with a defensive snapshot. */
export function transferWorktreeAuthority(source, target) {
  if (source === null || typeof source !== 'object' || target === null || typeof target !== 'object') return false;
  const authority = bindings.get(source);
  if (authority === undefined) return false;
  bindings.set(target, authority);
  return true;
}

export function boundWorktreeAuthority(handle) {
  return handle !== null && typeof handle === 'object' ? bindings.get(handle) ?? null : null;
}
