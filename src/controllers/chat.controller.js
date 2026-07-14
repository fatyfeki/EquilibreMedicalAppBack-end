// src/controllers/chat.controller.js
const { getChatReply } = require("../services/llm.service");

async function postChat(req, res, next) {
  try {
    const { history, message } = req.body;

    if (!message || typeof message !== "string" || !message.trim()) {
      return res
        .status(400)
        .json({ error: "Le champ 'message' est requis et doit être une chaîne non vide." });
    }

    if (history && !Array.isArray(history)) {
      return res.status(400).json({ error: "Le champ 'history' doit être un tableau." });
    }

    const reply = await getChatReply(history, message);
    res.json({ reply });
  } catch (err) {
    next(err);
  }
}

module.exports = { postChat };