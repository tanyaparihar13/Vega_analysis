import { createContext, useContext, useState, useCallback } from 'react';
import api from '../api/axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('vega_user');
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(false);

  const persist = (token, userData) => {
    localStorage.setItem('vega_token', token);
    localStorage.setItem('vega_user', JSON.stringify(userData));
    setUser(userData);
  };

  const login = useCallback(async (email, password) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      persist(data.token, data.user);
      return data.user;
    } finally {
      setLoading(false);
    }
  }, []);

  const adminLogin = useCallback(async (email, password) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/admin-login', { email, password });
      persist(data.token, data.user);
      return data.user;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Registration no longer signs the user in, and no longer ends at WhatsApp.
   *
   * New accounts are created with status='pending' and cannot authenticate
   * until an admin approves them, so the server returns no session JWT.
   * Persisting one here would drop an unapproved user straight into the
   * dashboard and make the approval gate decorative.
   *
   * What it DOES return is a scope-limited `onboardingToken`, which authorises
   * exactly one thing: recording this account's onboarding choice on the next
   * screen. See server/src/middleware/auth.js — `authenticate` rejects it
   * everywhere else.
   *
   * STORED IN sessionStorage, NOT localStorage. It is a 30-minute credential
   * for one page transition; sessionStorage means it dies with the tab and is
   * never mistaken for a session by anything that reads `vega_token`. It also
   * survives a refresh on /onboarding, which router state alone would not.
   */
  const register = useCallback(async ({ name, email, password, confirmPassword, mobile, broker }) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', {
        name, email, password, confirmPassword, mobile, broker,
      });
      if (data.onboardingToken) {
        sessionStorage.setItem('vega_onboarding_token', data.onboardingToken);
      }
      return data; // { status, message, user, onboardingToken, nextStep }
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Records the onboarding choice and returns the prefilled WhatsApp link.
   *
   * The token is read from sessionStorage rather than passed in, so the page
   * component never has to hold a credential in React state where a re-render
   * or an error boundary could strand it.
   */
  const selectOnboardingOption = useCallback(async (option) => {
    const token = sessionStorage.getItem('vega_onboarding_token');
    if (!token) {
      const err = new Error('ONBOARDING_TOKEN_MISSING');
      err.code = 'ONBOARDING_TOKEN_MISSING';
      throw err;
    }
    const { data } = await api.post(
      '/auth/onboarding/select',
      { option },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data; // { ok, selectedOption, label, priceInr, whatsappUrl }
  }, []);

  /** Best-effort funnel telemetry — never blocks or surfaces an error. */
  const markWhatsappOpened = useCallback(async () => {
    const token = sessionStorage.getItem('vega_onboarding_token');
    if (!token) return;
    try {
      await api.post('/auth/onboarding/whatsapp-opened', {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* telemetry only — the choice is already recorded */ }
  }, []);

  /** Called once the funnel is finished, so the credential does not linger. */
  const clearOnboardingToken = useCallback(() => {
    sessionStorage.removeItem('vega_onboarding_token');
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('vega_token');
    localStorage.removeItem('vega_user');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user, loading, login, adminLogin, register, logout,
        selectOnboardingOption, markWhatsappOpened, clearOnboardingToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
