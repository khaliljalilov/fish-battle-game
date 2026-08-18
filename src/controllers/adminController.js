/**
 * adminController.js — promote/revoke a user's subscription.
 * Every route here already passed adminAuth before reaching this file.
 */

const User = require('../models/User');

async function promote(req, res, next) {
  try {
    const { email, days } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Defaults to 30 when omitted; also falls back on garbage input (0,
    // negative, non-numeric) rather than writing a bad expiry date.
    const numericDays = Number(days);
    const durationDays = Number.isFinite(numericDays) && numericDays > 0 ? numericDays : 30;

    user.role = 'premium';
    user.subscriptionExpiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    await user.save();

    return res.json({
      success: true,
      email: user.email,
      role: user.role,
      subscriptionExpiresAt: user.subscriptionExpiresAt
    });
  } catch (err) {
    next(err);
  }
}

async function revoke(req, res, next) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    user.role = 'free';
    user.subscriptionExpiresAt = null;
    await user.save();

    return res.json({
      success: true,
      email: user.email,
      role: user.role,
      subscriptionExpiresAt: user.subscriptionExpiresAt
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { promote, revoke };
