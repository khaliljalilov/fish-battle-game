const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const { promote, revoke } = require('../controllers/adminController');

const router = express.Router();

// Every route below requires a valid x-admin-key header.
router.use(adminAuth);

router.post('/promote', promote);
router.post('/revoke', revoke);

module.exports = router;
