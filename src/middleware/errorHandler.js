/**
 * errorHandler.js — last-resort catch for anything a route's own try/catch
 * didn't handle. Must be registered after every route in server.js — Express
 * only treats a 4-arg function as error-handling middleware, and only errors
 * passed via next(err) reach it.
 */

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  console.error('[error]', err);

  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: status === 500 ? 'Internal server error.' : err.message
  });
}

module.exports = errorHandler;
