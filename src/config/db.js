/**
 * db.js — MongoDB connection for the auth service, via Mongoose.
 *
 * Separate from server/store.js on purpose: that file is the game server's
 * raw-driver connection to the fish arena's database. This service is a
 * standalone process with its own .env (see src/.env.example), so it gets
 * its own connection rather than sharing state with the game server.
 */

const mongoose = require('mongoose');

// This service must only ever talk to MongoDB Atlas. Fail fast rather than
// silently accepting a local connection string — see server/store.js for
// the matching guard on the game server's side.
const LOCAL_MONGO_PATTERN = /localhost|127\.0\.0\.1/i;

async function connectDB() {
  if (LOCAL_MONGO_PATTERN.test(process.env.MONGO_URI || '')) {
    console.error('[fatal] MONGO_URI points at local MongoDB. This project requires MongoDB Atlas — set MONGO_URI to your Atlas connection string in src/.env.');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`[db] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (err) {
    console.error(`[db] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = connectDB;
