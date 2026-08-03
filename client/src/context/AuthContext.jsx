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
   * Registration no longer signs the user in.
   *
   * New accounts are created with status='pending' and cannot authenticate
   * until an admin approves them, so the server returns no JWT — it returns
   * the pending state plus the prefilled WhatsApp handoff link. Persisting a
   * session here would drop an unapproved user straight into the dashboard.
   */
  const register = useCallback(async ({ name, email, password, mobile, broker }) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', { name, email, password, mobile, broker });
      return data; // { status, message, user, whatsappUrl }
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('vega_token');
    localStorage.removeItem('vega_user');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, adminLogin, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
