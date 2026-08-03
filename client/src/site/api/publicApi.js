import axios from 'axios';

/**
 * HTTP client for the PUBLIC marketing site.
 *
 * Deliberately NOT `src/api/axios.js`. That instance attaches the stored JWT
 * and, on any 401, clears the session and hard-redirects the browser to
 * /login. Both behaviours are wrong here:
 *
 *   - a signed-in user browsing the marketing pages would send their token to
 *     endpoints that neither need nor should see it;
 *   - a transient 401 from a public endpoint would throw a visitor who has
 *     never had an account onto a login screen for no reason, and would log
 *     out a user who was simply reading the pricing page.
 *
 * So this client carries no credentials and no interceptors. Public endpoints
 * fail quietly and the calling component renders its own empty state.
 */
const publicApi = axios.create({
  baseURL: '/api/public',
  timeout: 15000,
});

export default publicApi;
