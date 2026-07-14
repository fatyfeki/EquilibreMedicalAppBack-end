// src/config/env.js
require("dotenv").config();

// GROQ_API_KEY est obligatoire (fournisseur principal, rapide).
// OPENROUTER_API_KEY est optionnelle : sans elle, il n'y a simplement
// pas de repli si Groq tombe en panne ou est rate-limité.
const required = ["GROQ_API_KEY"];

required.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`⚠️  Variable d'environnement manquante : ${key}`);
  }
});

if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "ℹ️  OPENROUTER_API_KEY non définie : pas de fournisseur de secours si Groq échoue.",
  );
}

module.exports = {
  PORT: process.env.PORT || 3000,

  GROQ_API_KEY: process.env.GROQ_API_KEY,
  // openai/gpt-oss-120b : bon rapport vitesse/qualité chez Groq en 2026.
  // Vérifie console.groq.com/docs/models pour la liste à jour.
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  // Modèle gratuit chez OpenRouter, utilisé uniquement en repli.
  // Vérifie openrouter.ai/models?max_price=0 pour la liste à jour.
  OPENROUTER_MODEL:
    process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",

  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : "*",
};