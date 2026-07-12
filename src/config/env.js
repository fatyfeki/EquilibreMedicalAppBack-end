// src/config/env.js
require("dotenv").config();

const required = ["GEMINI_API_KEY"];   // ⚠️ doit être le NOM de la variable, pas la clé

required.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`⚠️  Variable d'environnement manquante : ${key}`);
  }
});

module.exports = {
  PORT: process.env.PORT || 3000,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : "*",
};