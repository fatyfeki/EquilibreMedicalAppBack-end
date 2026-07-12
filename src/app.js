// src/app.js
const express = require("express");
const cors = require("cors");

const chatRoutes = require("./routes/chat.routes");
const errorHandler = require("./middlewares/errorHandler");
const { ALLOWED_ORIGINS } = require("./config/env");

const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Simple healthcheck, utile pour vérifier que le serveur tourne
// (et pour les plateformes de déploiement type Render/Railway).
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/chat", chatRoutes);

// 404 pour toute route non gérée
app.use((req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});

// Toujours en dernier
app.use(errorHandler);

module.exports = app;