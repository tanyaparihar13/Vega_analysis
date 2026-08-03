const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const zerodhaRoutes = require('./routes/zerodhaRoutes');
const marketRoutes = require('./routes/marketRoutes');
const greeksRoutes = require('./routes/greeksRoutes');
const optionRoutes = require('./routes/optionRoutes'); // NEW — option chain
const vegaRoutes = require('./routes/vegaRoutes');
const publicRoutes = require('./routes/publicRoutes'); // NEW — unauthenticated marketing-site data

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

// Basic rate limiting on auth endpoints to slow brute-force attempts
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/auth', authLimiter, authRoutes);

/**
 * The ONLY unauthenticated data routes in the app — the delayed Vega series the
 * public site shows to visitors who have not registered. Mounted before the
 * authenticated routers purely so it reads as the exception it is; the paths do
 * not overlap. It brings its own rate limiter (see the router).
 */
app.use('/api/public', publicRoutes);

app.use('/api/admin', adminRoutes);
app.use('/api/zerodha', zerodhaRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/greeks', greeksRoutes);
app.use('/api/options', optionRoutes); // NEW — option chain
app.use('/api/vega', vegaRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Vega Analysis API' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ message: 'Internal server error' });
});

module.exports = app;