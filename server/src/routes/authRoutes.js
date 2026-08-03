const express = require('express');
const router = express.Router();
const { register, login, adminLogin, me, publicConfig } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

router.get('/config', publicConfig); // public: admin WhatsApp number for the signup handoff
router.post('/register', register);
router.post('/login', login);
router.post('/admin-login', adminLogin);
router.get('/me', authenticate, me);

module.exports = router;
