// src/routes/chat.routes.js
const express = require("express");
const { postChat } = require("../controllers/chat.controller");

const router = express.Router();

// POST /api/chat  { history: [...], message: "..." }  ->  { reply: "..." }
router.post("/", postChat);

module.exports = router;