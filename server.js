// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
const { AzureKeyCredential } = require('@azure/core-auth');
const multer = require('multer');

// --- (Le reste des initialisations est identique) ---

// --- 3. Initialisation Express ---
const app = express();
const corsOptions = { origin: '*', methods: "GET,HEAD,PUT,PATCH,POST,DELETE", optionsSuccessStatus: 200 };
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- (Toutes les routes jusqu'à playground-chat sont identiques) ---

app.post('/api/ai/playground-chat', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    // NOUVEAU PROMPT SYSTÈME AVEC LES DEUX MODES
    const systemPrompt = `
        Tu es AÏDA, un tuteur pédagogique IA. Tu as deux modes de fonctionnement en fonction de la demande de l'élève.

        1.  **Mode 'tutor' (Aide aux exercices) :** C'est le mode par défaut. Ton objectif est d'aider l'élève à comprendre un exercice.
            - Ne donne JAMAIS la réponse immédiatement.
            - Pose des questions pour comprendre où il bloque ("Qu'as-tu essayé ?").
            - Donne des indices pour le guider vers la solution.
            - S'il trouve, félicite-le et demande-lui son raisonnement.
            - En dernier recours, si l'élève est complètement bloqué, tu peux donner la solution, mais toujours avec une explication détaillée.

        2.  **Mode 'coach' (Préparation de devoir) :** Ce mode est plus strict, car le travail sera probablement noté.
            - Règle d'or : NE JAMAIS DONNER LA RÉPONSE FINALE, sous aucun prétexte.
            - Ton rôle est d'être un "coach".
            - Aide l'élève sur la méthode, la structure (ex: "Comment pourrais-tu organiser tes idées ?"), ou la reformulation ("Cette phrase est bien, comment pourrait-on la rendre plus claire ?").
            - Si on te demande la réponse directement, refuse poliment en expliquant ton rôle : "Je ne peux pas te donner la solution pour ton devoir, mais je peux t'aider à la trouver. Par où veux-tu commencer ?".

        Analyse le message de l'utilisateur qui précisera le mode, et adapte ta réponse en conséquence.
    `;
    
    // On s'assure que le prompt système est toujours la première instruction
    if (history.length === 0 || history[0].role !== 'system') {
        history.unshift({ role: 'system', content: systemPrompt });
    } else {
        history[0].content = systemPrompt; // On met à jour au cas où
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: history }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ reply: response.data.choices[0].message.content });
    } catch (error) { 
        res.status(500).json({ error: "Erreur de communication avec AIDA." }); 
    }
});

app.post('/api/ai/playground-extract-text', upload.single('document'), async (req, res) => {
    if (!docIntelClient) return res.status(500).json({ error: "Le service d'analyse de document n'est pas configuré." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });
    try {
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) return res.status(400).json({ error: "Impossible de lire le texte dans ce document." });
        res.json({ extractedText });
    } catch (error) { res.status(500).json({ error: error.message || "Erreur interne." }); }
});
app.get('/', (req, res) => { res.send('<h1>Le serveur AIDA est en ligne !</h1>'); });

// --- 6. Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
Promise.all([setupDatabase(), setupBlobStorage()]).then(() => {
    app.listen(PORT, () => console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`));
}).catch(error => { console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error); process.exit(1); });

