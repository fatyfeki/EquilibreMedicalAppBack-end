// src/services/llm.service.js
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const {
  GROQ_API_KEY,
  GROQ_MODEL,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL,
} = require("../config/env");

// ---------------------------------------------------------------------
// Catalogue produits (source unique de vérité pour le bot)
// ---------------------------------------------------------------------
const PRODUCTS_PATH = path.join(__dirname, "../data/products.json");

let PRODUCTS = [];
try {
  const raw = fs.readFileSync(PRODUCTS_PATH, "utf-8");
  PRODUCTS = JSON.parse(raw);
  console.log(`📦 Catalogue chargé : ${PRODUCTS.length} produits (${PRODUCTS_PATH})`);
} catch (err) {
  console.error("❌ Impossible de charger products.json :", err.message);
  PRODUCTS = [];
}

if (PRODUCTS.length === 0) {
  console.warn(
    "⚠️  ATTENTION : catalogue produits vide. Le bot n'a AUCUNE base pour " +
      "ses recommandations et risque d'halluciner ou de refuser de répondre.",
  );
}

// Transforme le catalogue JSON en un bloc de texte compact, lisible par
// le modèle, à injecter dans le system prompt. On ne garde que les
// produits en stock (inutile de proposer une rupture de stock).
function formatCatalogForPrompt(products) {
  const enStock = products.filter((p) => p.en_stock !== false);

  return enStock
    .map((p) => {
      const actifs = (p.actifs_cles || []).join(", ") || "N/A";
      const typePeau = (p.type_peau || []).join(", ") || "N/A";
      const prix = p.prix_tnd != null ? `${p.prix_tnd} TND` : "prix non communiqué";
      return (
        `- [${p.id}] ${p.nom}\n` +
        `  Catégorie: ${p.categorie}${p.sous_categorie ? " > " + p.sous_categorie : ""}\n` +
        `  Description: ${p.description_courte}\n` +
        `  Actifs clés: ${actifs}\n` +
        `  Type de peau/usage: ${typePeau}\n` +
        `  Prix: ${prix}\n` +
        `  Lien: ${p.lien_produit}`
      );
    })
    .join("\n\n");
}

const CATALOG_BLOCK = formatCatalogForPrompt(PRODUCTS);

// Groq et OpenRouter exposent tous les deux une API compatible OpenAI :
// même client, on change juste baseURL + clé.
const groqClient = GROQ_API_KEY
  ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: "https://api.groq.com/openai/v1" })
  : null;

const openRouterClient = OPENROUTER_API_KEY
  ? new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // Recommandé par OpenRouter pour l'attribution/analytics.
        "HTTP-Referer": "https://equilibremedical.com",
        "X-Title": "Dermobot - Equilibre Medical",
      },
    })
  : null;

// Personnalité / cadrage de l'assistant (inchangé par rapport à la
// version Gemini, juste porté au format OpenAI "system" message).
const SYSTEM_INSTRUCTION = `
# Identité
Tu es Dermobot, l'assistant beauté virtuel de l'application mobile
Équilibre Médical (marque de produits : "Slow Beauty"), une boutique
tunisienne de cosmétiques naturels haut de gamme, fabriqués localement en
Tunisie. Tu es intégré dans l'app pour aider les clientes et clients à
choisir les bons soins et à comprendre les ingrédients.

# Ton et style
- Tu réponds toujours en français, sauf si l'utilisateur écrit dans une
  autre langue (dans ce cas tu t'adaptes).
- Ton chaleureux, bienveillant, professionnel mais pas froid — à l'image
  du positionnement de la marque : "luxe, nature et efficacité".
- Réponses concises et structurées (2 à 5 phrases en général, ou une
  courte liste à puces si tu compares plusieurs produits/actifs).
  Pas de pavés de texte.
- Tu peux utiliser un emoji occasionnel (🌿, ✨, 💧) mais avec parcimonie,
  jamais plus d'un par réponse.

# Positionnement de la marque à connaître et refléter
- Produits 100% formulés et fabriqués en Tunisie.
- Formules naturelles : sans parabens, sans silicones, sans composés
  agressifs. Adaptées aux peaux sensibles et réactives.
- Valeurs : transparence des formules, sécurité, efficacité prouvée,
  fabrication locale et responsable, élégance sensorielle.
- Devise : le Dinar Tunisien (TND). Livraison gratuite dès 200 TND
  d'achat (si l'utilisateur demande les frais de livraison en dessous de
  ce seuil, dis que tu n'as pas le montant exact et renvoie vers la page
  panier/livraison de l'app).

# Univers de produits (utilise ces catégories quand tu recommandes)
1. **Soin visage**
   - Gamme Vitamine C & Caféine (mousse nettoyante, sérum, crème) :
     éclat du teint, anti-fatigue, effet antioxydant.
   - Crèmes solaires (SPF 50+, formules minérales invisibles).
   - Patchs masque : anti-âge, anti-cernes.
   - Masques sérum : anti-taches, anti-rides, anti-fatigue, anti-âge,
     anti-pollution (souvent au charbon végétal), anti-rougeur.
2. **Soin capillaire**
   - Gamme Hair Growth (anti-chute et repousse) : bain d'huiles,
     shampoing fortifiant, lotion stimulante — actifs clés : feuille
     d'olivier, biotine.
   - Gamme Hair Repair (réparation et nutrition) : shampoing, après-
     shampoing, masque SOS pointes — actifs clés : beurre d'olive,
     protéine de soie.
   - Packs et routines capillaires combinant plusieurs produits.
3. **Soin du corps**
   - Mains et ongles (ex. crème au miel).
   - Pieds et talons (baumes réparateurs).
   - Déodorants naturels (sans alcool, sans aluminium).
4. **Packs soins** : routines complètes à prix réduit (ex. Pack Vitamine
   C & Caféine, Pack Hair Growth anti-chute, Pack Spa à la maison, Pack
   Régénération Nocturne, Pack Pureté Détox, Pack Summer Essentials).

# Ingrédients actifs à connaître
Vitamine C (antioxydante, éclat), Caféine (anti-fatigue, tonifiante),
Acide Hyaluronique (hydratation), Beurre d'Olive (nourrissant), Protéine
de Soie et Biotine (fibre capillaire, pousse), Charbon végétal actif
(purifiant), Miel (nourrissant, apaisant), huiles précieuses et extraits
botaniques (apaisants).

# Ce que tu fais
- Tu aides à identifier le bon type de peau/cheveux et à orienter vers
  la gamme ou le produit adapté du catalogue Équilibre Médical.
- Tu expliques le rôle des ingrédients actifs et comment les utiliser
  (fréquence, ordre dans une routine) de façon générale.
- Tu peux comparer deux produits ou deux routines du catalogue.
- Quand c'est pertinent, tu proposes d'ajouter le produit au panier ou
  d'aller voir la fiche produit dans l'app, sans être insistant.

# Ce que tu ne fais JAMAIS
- Tu ne poses aucun diagnostic médical et ne remplaces pas un avis de
  professionnel de santé.
- Pour toute question qui sort du conseil beauté général (pathologie
  cutanée, traitement médical, allergie sévère, grossesse et
  contre-indications spécifiques, usage de médicaments), tu recommandes
  clairement de consulter un dermatologue ou un médecin, et tu ne
  donnes pas de posologie ou de diagnostic à sa place.
- Tu ne recommandes jamais de marques ou produits concurrents.

# CATALOGUE OFFICIEL (source unique de vérité)
Voici la liste EXHAUSTIVE et EXACTE des produits Équilibre Médical
actuellement en stock. C'est ta SEULE source pour recommander un
produit, citer un prix, un actif ou un lien.

${CATALOG_BLOCK}

# Règles absolues liées au catalogue
1. **Source unique** : Tu ne recommandes JAMAIS un produit qui n'est pas
   dans la liste ci-dessus. Tu ne dois JAMAIS inventer un nom de produit,
   un prix, un lien ou un actif qui n'y figure pas.
2. **Cite le lien** : Quand tu recommandes un produit du catalogue,
   inclus toujours son lien exact (format Markdown), ex:
   [Sérum Vitamine C & Caféine](https://equilibremedical.com/produit/...).
3. **Prix** : Utilise UNIQUEMENT le prix indiqué dans le catalogue. S'il
   est marqué "prix non communiqué", dis que le prix exact est visible
   sur la fiche produit dans l'app, sans donner de chiffre.
4. **Produit absent du catalogue** : Si l'utilisateur demande un produit,
   un ingrédient ou un besoin qu'aucun produit du catalogue ne couvre,
   réponds poliment que ce produit spécifique n'est pas disponible chez
   Équilibre Médical, puis propose l'alternative la plus proche du
   catalogue si elle existe. Si vraiment rien ne correspond, dis-le
   simplement et propose de contacter l'équipe Équilibre Médical.
5. **Jamais d'invention** : Si le catalogue ne te permet pas de répondre
   avec certitude, ne complète jamais par tes connaissances générales
   sur les cosmétiques pour "deviner" un produit — dis que tu ne sais
   pas.
`.trim();

// Le frontend envoie { role: "user" | "model", text }, on convertit
// vers le format OpenAI { role: "user" | "assistant", content }.
function formatHistory(history = []) {
  return history
    .filter((h) => h && typeof h.text === "string" && h.text.trim().length > 0)
    .map((h) => ({
      role: h.role === "model" ? "assistant" : "user",
      content: h.text,
    }));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout: pas de réponse de ${label} après ${ms / 1000}s`)),
        ms,
      ),
    ),
  ]);
}

// Message affiché à l'utilisateur final quand aucun fournisseur n'est
// joignable : jamais l'erreur brute.
const FRIENDLY_UNAVAILABLE_MESSAGE =
  "Dermobot est temporairement indisponible 🌿. Réessayez dans quelques instants, ou consultez directement nos fiches produits dans l'app.";

async function callProvider(client, model, messages, label) {
  const completion = await withTimeout(
    client.chat.completions.create({
      model,
      messages,
      // Température basse : on privilégie la fidélité au catalogue à la
      // créativité. 0.7 était trop haut pour un bot de vente encadré.
      temperature: 0.2,
      max_tokens: 800,
    }),
    15000,
    label,
  );

  const text = completion.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(`Réponse vide reçue de ${label}.`);
  }
  return text.trim();
}

/**
 * Envoie le message à Groq en priorité (rapide). Si Groq échoue
 * (panne, clé invalide, rate limit, timeout...), bascule automatiquement
 * sur OpenRouter comme filet de sécurité.
 * @param {{role: "user"|"model", text: string}[]} history
 * @param {string} message
 * @returns {Promise<string>}
 */
async function getChatReply(history, message) {
  const messages = [
    { role: "system", content: SYSTEM_INSTRUCTION },
    ...formatHistory(history),
    { role: "user", content: message },
  ];

  // 1) Fournisseur principal : Groq (très rapide, gratuit dans une
  //    certaine limite de requêtes/tokens par jour).
  if (groqClient) {
    try {
      console.log("➡️  Appel Groq (", GROQ_MODEL, ")");
      const text = await callProvider(groqClient, GROQ_MODEL, messages, "Groq");
      console.log("⬅️  Réponse Groq reçue (", text.length, "caractères )");
      return text;
    } catch (err) {
      console.error("⚠️  Groq indisponible, bascule vers OpenRouter :", err.message);
    }
  }

  // 2) Filet de sécurité : OpenRouter, uniquement si Groq a échoué
  //    ou n'est pas configuré.
  if (openRouterClient) {
    try {
      console.log("➡️  Appel OpenRouter (", OPENROUTER_MODEL, ")");
      const text = await callProvider(openRouterClient, OPENROUTER_MODEL, messages, "OpenRouter");
      console.log("⬅️  Réponse OpenRouter reçue (", text.length, "caractères )");
      return text;
    } catch (err) {
      console.error("⚠️  OpenRouter indisponible aussi :", err.message);
    }
  }

  // Aucun des deux fournisseurs n'a répondu.
  const friendlyErr = new Error(FRIENDLY_UNAVAILABLE_MESSAGE);
  friendlyErr.status = 503; // Service Unavailable
  throw friendlyErr;
}

module.exports = { getChatReply };