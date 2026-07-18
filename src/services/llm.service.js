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

const PRODUITS_EN_STOCK = PRODUCTS.filter((p) => p.en_stock !== false);

// ---------------------------------------------------------------------
// 1) INDEX léger : toujours envoyé en entier, pour que le bot sache ce
//    qui existe dans le catalogue même sans les détails complets.
//    Volontairement compact (1 ligne/produit) pour rester économe en
//    tokens (contrainte du plan gratuit Groq : 6000-8000 tokens/minute).
// ---------------------------------------------------------------------
function buildCatalogIndex(products) {
  // Format volontairement minimaliste : id, nom, catégorie, lien - un
  // token économisé ici est répété 47 fois.
  return products.map((p) => `[${p.id}] ${p.nom} (${p.categorie}) ${p.lien_produit}`).join("\n");
}

const CATALOG_INDEX = buildCatalogIndex(PRODUITS_EN_STOCK);

// ---------------------------------------------------------------------
// 2) DÉTAILS complets : formatés uniquement pour les produits jugés
//    pertinents par rapport au message de l'utilisateur (voir
//    getRelevantProducts). C'est la partie "RAG" : on ne charge que ce
//    qui est utile à CETTE question, pas tout le catalogue.
// ---------------------------------------------------------------------
function formatProductDetails(products) {
  return products
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

// Mots trop génériques pour servir de critère de recherche.
const STOPWORDS = new Set([
  "les", "des", "une", "un", "le", "la", "de", "du", "et", "ou", "pour",
  "avec", "sans", "sur", "dans", "que", "qui", "quoi", "comment", "est",
  "ce", "cette", "vous", "votre", "moi", "j'ai", "jai", "mon", "ma", "mes",
  "quel", "quelle", "quels", "quelles", "bonjour", "svp", "merci",
]);

function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractKeywords(text) {
  return stripAccents(text.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Sélectionne les produits les plus pertinents pour le message de
// l'utilisateur, par simple correspondance de mots-clés sur le nom, la
// catégorie, les actifs, le type de peau et la description. C'est un RAG
// volontairement simple (pas d'embeddings) : suffisant pour ~50 produits,
// et surtout ça évite de dépasser les quotas de tokens du plan gratuit.
function getRelevantProducts(message, products, maxResults = 5) {
  const keywords = extractKeywords(message);
  if (keywords.length === 0) return [];

  const scored = products.map((p) => {
    const haystack = stripAccents(
      [
        p.nom,
        p.categorie,
        p.sous_categorie,
        ...(p.actifs_cles || []),
        ...(p.type_peau || []),
        p.description_courte,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    );

    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score += 1;
      // Le nom du produit compte double : une correspondance sur le nom
      // exact est un signal beaucoup plus fort qu'un mot perdu dans la
      // description.
      if (stripAccents(p.nom.toLowerCase()).includes(kw)) score += 1;
    }
    return { product: p, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.product);
}

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

// Personnalité / cadrage de l'assistant. La base est fixe, mais le bloc
// "DÉTAILS PRODUITS PERTINENTS" change à chaque message : on n'y met que
// les quelques produits liés à la question posée (RAG), pas tout le
// catalogue, pour rester sous les quotas de tokens/minute.
function buildSystemInstruction(userMessage) {
  const relevant = getRelevantProducts(userMessage, PRODUITS_EN_STOCK);
  const detailsBlock =
    relevant.length > 0
      ? formatProductDetails(relevant)
      : "(Aucun produit du catalogue ne correspond clairement à cette question " +
        "d'après les mots-clés utilisés. Utilise l'INDEX ci-dessus pour voir ce " +
        "qui existe, mais ne donne pas de détails que tu ne connais pas : pose " +
        "une question de clarification, ou oriente vers une catégorie.)";

  return SYSTEM_INSTRUCTION_TEMPLATE(detailsBlock);
}

const SYSTEM_INSTRUCTION_TEMPLATE = (detailsBlock) => `
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

# Univers de produits
4 grandes familles au catalogue : Soin visage, Soin capillaire, Soin du
corps, et des Packs soins combinant plusieurs produits à prix réduit.
Le détail exact (produits, actifs, prix) t'est donné plus bas dans
l'INDEX et les DÉTAILS — ne t'appuie pas sur tes connaissances générales
en cosmétique pour compléter.

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

# INDEX DU CATALOGUE (liste EXHAUSTIVE et EXACTE des produits en stock)
Tu ne dois JAMAIS mentionner ou inventer un produit qui n'est pas dans
cet index. C'est ta seule source pour savoir ce qui existe :

${CATALOG_INDEX}

# DÉTAILS PRODUITS PERTINENTS pour la question posée
Pour les produits ci-dessous (sélectionnés car liés à la question de
l'utilisateur), tu as une fiche complète : description, actifs, type de
peau, prix, lien. Utilise UNIQUEMENT ces informations pour argumenter en
détail — ne complète jamais avec des connaissances générales sur les
cosmétiques.

${detailsBlock}

# Règles absolues liées au catalogue
1. **Source unique** : Tu ne recommandes JAMAIS un produit qui n'est pas
   dans l'INDEX ci-dessus. Tu ne dois JAMAIS inventer un nom de produit,
   un prix, un actif ou un lien.
2. **Détails limités** : Tu ne peux donner des détails précis (actifs,
   prix, description) QUE pour les produits présents dans le bloc
   "DÉTAILS PRODUITS PERTINENTS". Pour un produit de l'INDEX qui n'a pas
   de fiche détaillée ici, dis que tu n'as pas plus de précisions sous
   la main et renvoie vers sa fiche produit dans l'app (dont tu as le
   lien dans l'INDEX) plutôt que d'inventer.
3. **Référence un produit avec un tag** : quand tu recommandes ou cites un
   produit précis du catalogue, ajoute juste après son nom le tag exact
   [[PRODUIT:id]] (avec le vrai id numérique de l'INDEX), par exemple :
   "Je vous recommande notre Sérum Vitamine C & Caféine [[PRODUIT:1565]]."
   N'écris JAMAIS l'URL toi-même, n'utilise JAMAIS de lien Markdown
   [texte](url) : uniquement ce tag [[PRODUIT:id]], une carte produit
   cliquable sera affichée automatiquement à sa place dans l'app.
4. **Prix** : Utilise UNIQUEMENT le prix indiqué dans les DÉTAILS. S'il
   est marqué "prix non communiqué", dis que le prix exact est visible
   sur la fiche produit dans l'app, sans donner de chiffre.
5. **Produit absent du catalogue** : Si l'utilisateur demande un produit,
   un ingrédient ou un besoin qu'aucun produit de l'INDEX ne couvre,
   réponds poliment que ce produit spécifique n'est pas disponible chez
   Équilibre Médical, puis propose l'alternative la plus proche si elle
   existe. Si vraiment rien ne correspond, dis-le simplement et propose
   de contacter l'équipe Équilibre Médical.
6. **Jamais d'invention** : Si tu ne peux pas répondre avec certitude à
   partir de l'INDEX et des DÉTAILS fournis, ne complète jamais par tes
   connaissances générales sur les cosmétiques pour "deviner" — dis que
   tu ne sais pas, ou pose une question de clarification.
`;

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

// Reconnaît les tags [[PRODUIT:id]] que le modèle place après un nom de
// produit. On les retire du texte affiché et on renvoie à la place une
// liste structurée, pour que le frontend affiche de vraies cartes
// produit cliquables plutôt que du texte brut.
const PRODUCT_TAG_REGEX = /\s*\[\[PRODUIT:([a-zA-Z0-9_-]+)\]\]/g;

function extractProductReferences(rawText) {
  const foundIds = [];
  let match;
  PRODUCT_TAG_REGEX.lastIndex = 0;
  while ((match = PRODUCT_TAG_REGEX.exec(rawText)) !== null) {
    foundIds.push(match[1]);
  }

  const cleanedText = rawText.replace(PRODUCT_TAG_REGEX, "").trim();

  // On déduplique tout en gardant l'ordre d'apparition, et on ne garde
  // que les ids qui existent réellement dans le catalogue (le modèle
  // peut se tromper malgré les consignes).
  const seen = new Set();
  const products = [];
  for (const id of foundIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const product = PRODUITS_EN_STOCK.find((p) => p.id === id);
    if (product) {
      products.push({
        id: product.id,
        nom: product.nom,
        prix_tnd: product.prix_tnd ?? null,
        categorie: product.categorie,
        lien_produit: product.lien_produit,
      });
    }
  }

  return { reply: cleanedText, products };
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
      // Réduit de 800 à 500 : les réponses du bot sont censées être
      // courtes (2-5 phrases, cf. consignes de ton) et ce budget compte
      // aussi dans le quota tokens/minute de Groq.
      max_tokens: 500,
    }),
    // Remonté de 15s à 25s : sur le plan gratuit (Groq comme Render), un
    // pic de charge ponctuel peut dépasser 15s sans que le service soit
    // pour autant en panne. On laisse une vraie marge avant de basculer.
    25000,
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
 * @returns {Promise<{reply: string, products: object[]}>}
 */
async function getChatReply(history, message) {
  const messages = [
    { role: "system", content: buildSystemInstruction(message) },
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
      return extractProductReferences(text);
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
      return extractProductReferences(text);
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