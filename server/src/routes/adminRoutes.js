const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const admin = require('../controllers/adminController');
const adminData = require('../controllers/adminDataController');
const onboarding = require('../controllers/onboardingController');

router.use(authenticate, authorize('admin'));

router.get('/users', admin.listUsers);
router.patch('/users/:id/status', admin.toggleUserStatus);   // is_active toggle
router.patch('/users/:id/approval', admin.setUserApproval);  // approve/reject/block/unblock
router.patch('/users/:id/role', admin.updateUserRole);
router.delete('/users/:id', admin.deleteUser);

router.get('/login-history', admin.loginHistory); // doubles as "User Activity Log"
router.get('/live-activity', admin.liveActivity);

// Registration funnel — who registered, what they chose, and where they are in
// the payment / broker workflow. See controllers/onboardingController.js.
router.get('/onboarding', onboarding.listOnboarding);
router.patch('/onboarding/:userId', onboarding.updateOnboarding);

router.get('/notifications', onboarding.listNotifications);
router.patch('/notifications/:id/read', onboarding.readNotification);
router.post('/notifications/read-all', onboarding.readAllNotifications);

router.get('/plans', admin.listPlans);
router.post('/plans', admin.createPlan);

router.get('/subscriptions', admin.listSubscriptions);
router.post('/subscriptions', admin.assignSubscription);

// Live platform health — one aggregated call, polled by the admin panel.
router.get('/system-status', adminData.systemStatus);

// Data management
router.get('/data/vega-history', adminData.vegaHistory);
router.get('/data/export/csv', adminData.exportCsv);
router.get('/data/export/excel', adminData.exportExcel);
router.post('/data/purge', adminData.purgeData);
router.post('/data/backup', adminData.createBackup);
router.get('/data/backups', adminData.listBackups);
router.get('/data/backups/:filename/download', adminData.downloadBackup);

router.get('/audit-log', adminData.auditLog);

module.exports = router;
