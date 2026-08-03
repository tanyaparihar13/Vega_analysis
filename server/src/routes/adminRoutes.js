const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const admin = require('../controllers/adminController');
const adminData = require('../controllers/adminDataController');

router.use(authenticate, authorize('admin'));

router.get('/users', admin.listUsers);
router.patch('/users/:id/status', admin.toggleUserStatus);   // is_active toggle
router.patch('/users/:id/approval', admin.setUserApproval);  // approve/reject/block/unblock
router.patch('/users/:id/role', admin.updateUserRole);
router.delete('/users/:id', admin.deleteUser);

router.get('/login-history', admin.loginHistory); // doubles as "User Activity Log"
router.get('/live-activity', admin.liveActivity);

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
