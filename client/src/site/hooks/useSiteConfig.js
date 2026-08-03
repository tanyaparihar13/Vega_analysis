import { useEffect, useState } from 'react';
import publicApi from '../api/publicApi';

/**
 * `/api/public/site-config`, fetched at most once per page load.
 *
 * Three separate places want the admin WhatsApp number — the floating social
 * rail, its mobile counterpart, and the footer — and the Contact page wants the
 * email and phone too. Without a cache that is four identical requests on a
 * single visit, against an endpoint that is rate limited to 120/minute per IP.
 *
 * The cache is a PROMISE, not a value, so concurrent mounts during the first
 * render all await the same in-flight request rather than each starting one.
 *
 * A failure resolves to nulls rather than rejecting: every caller's correct
 * behaviour on error is "render nothing", and a public marketing page must
 * never surface a request failure to a passer-by.
 */

const EMPTY = { adminWhatsappNumber: null, contactEmail: null, contactPhone: null };

let cache = null;

function loadSiteConfig() {
  if (!cache) {
    cache = publicApi
      .get('/site-config')
      .then(({ data }) => data || EMPTY)
      .catch(() => EMPTY);
  }
  return cache;
}

export default function useSiteConfig() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    let alive = true;
    loadSiteConfig().then((data) => {
      if (alive) setConfig(data);
    });
    return () => { alive = false; };
  }, []);

  return config;
}
