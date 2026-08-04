import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('vega_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Endpoints where a 401 is an ANSWER, not an expired session.
 *
 * The interceptor below treats 401 as "your token died, start again" and
 * hard-redirects to /login. That is right for every authenticated endpoint and
 * wrong for the credential endpoints themselves: `POST /auth/login` answers a
 * wrong password with 401, so submitting a typo on the login screen assigned
 * `window.location.href = '/login'` while already on /login — which reloads the
 * page, discarding the "Invalid email or password" the form had just set. The
 * user saw a blank form flash and no reason why.
 *
 * Matched on the request path rather than by inspecting the response so it
 * cannot be confused by a proxy or an error shape.
 */
const CREDENTIAL_PATHS = [
  '/auth/login',
  '/auth/admin-login',
  '/auth/forgot-password',
  '/auth/reset-password',
];

const isCredentialRequest = (config) => {
  const url = config?.url || '';
  return CREDENTIAL_PATHS.some((p) => url.startsWith(p));
};

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !isCredentialRequest(err.config)) {
      localStorage.removeItem('vega_token');
      localStorage.removeItem('vega_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;



