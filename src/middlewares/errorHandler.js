// src/middlewares/errorHandler.js

// Doit être déclaré en dernier dans app.js (après toutes les routes) :
// Express le reconnaît comme error-handler grâce à ses 4 arguments.
function errorHandler(err, req, res, next) {
  console.error("❌ Erreur:", err.message);

  const status = err.status || 500;
  res.status(status).json({
    error:
      status === 500
        ? "Erreur interne du serveur."
        : err.message,
  });
}

module.exports = errorHandler;