const express = require('express');
const axios = require('axios');

// Agent Deepseek (chat par defaut)
async function getDeepseekPlaygroundCompletion(history) {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
    const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
    if (!DEEPSEEK_API_KEY) throw new Error("Clé API Deepseek non configurée.");
    const systemContent = `Tu es AIDA, un tuteur IA bienveillant et pédagogue.

    [MÉTHODE PÉDAGOGIQUE]
    - Guide l'élève, méthode socratique, ne donne pas la réponse.
    - Adapte ton langage à l'âge de l'élève.

    [FORMATAGE VISUEL & MATHS]
    1. MATHÉMATIQUES (LaTeX) : $...$ pour inline et $$...$$ pour centré.
    2. SCHÉMAS (Mermaid) : entoure le code de triple backticks + mot clé mermaid.

    [INTERDIT]
    - Pas de SVG.`;
    const deepseekHistory = [
        { role: "system", content: systemContent },
        ...history.filter(msg => msg.role !== 'system')
    ];
    try {
        const response = await axios.post(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
            model: DEEPSEEK_MODEL,
            messages: deepseekHistory
        }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erreur Deepseek:", error.response?.data || error.message);
        throw new Error("L'agent Deepseek n'a pas pu répondre.");
    }
}

// Agent Kimi / Moonshot (documents longs)
async function callKimiCompletion(history) {
    const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
    const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL;
    const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL;
    if (!MOONSHOT_API_KEY || !MOONSHOT_BASE_URL || !MOONSHOT_MODEL) {
        throw new Error("Clé API, URL de base ou Modèle Moonshot non configuré.");
    }
    const validHistory = history.filter(msg =>
        msg.role !== 'system' && msg.content && typeof msg.content === 'string' && msg.content.trim().length > 0
    );
    const kimiHistory = [
        { role: "system", content: "Tu es Kimi, un assistant IA spécialisé dans l'analyse de documents longs et complexes. Réponds en te basant sur les documents fournis dans l'historique. Sois concis et factuel." },
        ...validHistory
    ];
    try {
        const response = await axios.post(`${MOONSHOT_BASE_URL}/chat/completions`, {
            model: MOONSHOT_MODEL,
            messages: kimiHistory
        }, { headers: { 'Authorization': `Bearer ${MOONSHOT_API_KEY}` } });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erreur Kimi:", error.response?.data || error.message);
        throw new Error("L'agent Kimi n'a pas pu répondre.");
    }
}

module.exports = function ({ upload, formRecognizerClient }) {
    const router = express.Router();

    // --- Playground chat (routeur multi-agents) ---
    router.post('/ai/playground-chat', async (req, res) => {
        const { history, preferredAgent } = req.body;
        if (!history || history.length === 0) return res.status(400).json({ error: "L'historique est vide." });
        try {
            const lastMsg = history[history.length - 1].content;
            const isLongText = lastMsg.length > 10000;
            const keywordsForKimi = ['kimi', 'analyse ce document', 'lis ce texte'];
            const useKimi = preferredAgent === 'kimi' || keywordsForKimi.some(k => lastMsg.toLowerCase().includes(k)) || isLongText;
            let reply, agentName;
            if (useKimi) {
                reply = await callKimiCompletion(history);
                agentName = "Aïda-kimi";
            } else {
                reply = await getDeepseekPlaygroundCompletion(history);
                agentName = "Aïda-deep";
            }
            res.json({ reply, agent: agentName });
        } catch (error) {
            console.error("Erreur dans le routeur d'agent:", error);
            res.status(500).json({ error: error.message });
        }
    });

    // --- Playground chat streaming ---
    router.post('/ai/playground-chat-stream', async (req, res) => {
        const { history, preferredAgent } = req.body;
        if (!history || history.length === 0) return res.status(400).json({ error: "L'historique est vide." });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
        const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
        const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

        const systemContent = `Tu es AIDA, un tuteur IA bienveillant et pédagogue.

    [MÉTHODE PÉDAGOGIQUE]
    - Guide l'élève, méthode socratique, ne donne pas la réponse.
    - Adapte ton langage à l'âge de l'élève.

    [FORMATAGE VISUEL & MATHS]
    1. MATHÉMATIQUES (LaTeX) : $...$ pour inline et $$...$$ pour centré.
    2. SCHÉMAS (Mermaid) : entoure le code de triple backticks + mot clé mermaid.

    [INTERDIT]
    - Pas de SVG.`;

        const deepseekHistory = [
            { role: "system", content: systemContent },
            ...history.filter(msg => msg.role !== 'system')
        ];

        try {
            const response = await axios.post(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
                model: DEEPSEEK_MODEL,
                messages: deepseekHistory,
                stream: true
            }, {
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
                responseType: 'stream'
            });

            let buffer = '';
            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') { res.write('data: [DONE]\n\n'); return; }
                    try {
                        const parsed = JSON.parse(data);
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
                    } catch (e) {}
                }
            });

            response.data.on('end', () => { res.write('data: [DONE]\n\n'); res.end(); });
            response.data.on('error', (err) => { res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); });

        } catch (error) {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        }
    });

    // --- Generation de contenu ---
    router.post('/ai/generate-content', async (req, res) => {
        const { competences, contentType, exerciseCount, language } = req.body;
        const langMap = { 'Anglais': 'English', 'Arabe': 'Arabic', 'Espagnol': 'Spanish' };
        const targetLanguage = langMap[language];
        const baseInstructions = {
            quiz: `Génère exactement ${exerciseCount} questions. La structure JSON DOIT être : { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`,
            exercices: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "exercices", "content": [ { "enonce": "..." } ] }`,
            dm: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "dm", "content": [ { "enonce": "..." } ] }`,
            revision: `Génère une fiche de révision complète. La structure JSON DOIT être : { "title": "...", "type": "revision", "content": "..." }`
        };
        if (!baseInstructions[contentType]) return res.status(400).json({ error: "Type de contenu non supporté" });
        let systemPrompt, userPromptContent;
        if (targetLanguage) {
            const translatedInstructions = {
                quiz: `Generate exactly ${exerciseCount} questions. The JSON structure MUST be: { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`,
                exercices: `Generate exactly ${exerciseCount} exercises. The JSON structure MUST be: { "title": "...", "type": "exercices", "content": [ { "enonce": "..." } ] }`,
                dm: `Generate exactly ${exerciseCount} exercises. The JSON structure MUST be: { "title": "...", "type": "dm", "content": [ { "enonce": "..." } ] }`,
                revision: `Generate a complete review sheet. The JSON structure MUST be: { "title": "...", "type": "revision", "content": "..." }`
            };
            systemPrompt = `You are an expert pedagogical assistant for creating language learning content. Your entire response must be a valid JSON object only, with no text before or after. All text content within the JSON MUST be in ${targetLanguage}.`;
            userPromptContent = `I will provide a pedagogical skill described in French. Your task is to create a '${contentType}' in ${targetLanguage} for a student learning that language. The exercise should help them practice the provided skill. The French skill is: '${competences}'. Now, follow these structural rules: ${translatedInstructions[contentType]}`;
        } else {
            systemPrompt = "Tu es un assistant pédagogique expert dans la création de contenus éducatifs en français. Ta réponse doit être uniquement un objet JSON valide, sans aucun texte avant ou après.";
            userPromptContent = `Crée un contenu de type '${contentType}' pour un élève, basé sur la compétence suivante : '${competences}'. ${baseInstructions[contentType]} Le contenu doit être en français.`;
        }
        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPromptContent }],
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json({ structured_content: JSON.parse(response.data.choices[0].message.content) });
        } catch (error) {
            console.error("Erreur Deepseek:", error.response?.data || error.message);
            res.status(500).json({ error: "Erreur lors de la génération." });
        }
    });

    // --- Generation depuis document ---
    router.post('/ai/generate-from-upload', upload.single('document'), async (req, res) => {
        if (!formRecognizerClient) return res.status(503).json({ error: "Le service d'analyse de documents n'est pas configuré sur le serveur." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été chargé." });
        const { contentType, exerciseCount } = req.body;
        const instructionsMap = {
            quiz: `Génère exactement ${exerciseCount} questions. La structure JSON DOIT être : { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`,
            exercices: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "${contentType}", "content": [ { "enonce": "..." } ] }`,
            dm: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "${contentType}", "content": [ { "enonce": "..." } ] }`,
            revision: `Génère une fiche de révision. La structure JSON DOIT être : { "title": "...", "type": "revision", "content": "..." }`
        };
        try {
            const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", req.file.buffer);
            const { content } = await poller.pollUntilDone();
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "Tu es un assistant pédagogique expert. Ta réponse doit être uniquement un objet JSON valide, sans texte additionnel." },
                    { role: "user", content: `À partir du texte suivant: "${content}". Crée un contenu de type '${contentType}'. ${instructionsMap[contentType] || ''}` }
                ],
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json({ structured_content: JSON.parse(response.data.choices[0].message.content) });
        } catch (error) {
            console.error("Erreur lors de l'analyse ou de la génération:", error);
            res.status(500).json({ error: "Erreur du serveur." });
        }
    });

    // --- Extraction texte document ---
    router.post('/ai/playground-extract-text', upload.single('document'), async (req, res) => {
        if (!formRecognizerClient) return res.status(503).json({ error: "Le service d'analyse de documents n'est pas configuré sur le serveur." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été chargé." });
        try {
            const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", req.file.buffer);
            const { content } = await poller.pollUntilDone();
            res.json({ extractedText: content });
        } catch (error) {
            console.error("Erreur lors de l'extraction de texte:", error);
            res.status(500).json({ error: "Impossible d'analyser le document." });
        }
    });

    // --- Indice ---
    router.post('/ai/get-hint', async (req, res) => {
        const { questionText } = req.body;
        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "Tu es un tuteur. Donne un indice pour aider à résoudre la question, mais ne donne JAMAIS la réponse. Sois bref et encourageant." },
                    { role: "user", content: `Donne un indice pour la question : "${questionText}"` }
                ]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json({ hint: response.data.choices[0].message.content });
        } catch (error) { res.status(500).json({ error: "Indice indisponible." }); }
    });

    // --- Plan de cours ---
    router.post('/ai/generate-lesson-plan', async (req, res) => {
        const { theme, level, numSessions } = req.body;
        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "Tu es un concepteur pédagogique expert. Génère un plan de cours structuré en JSON. Ta réponse doit être uniquement un objet JSON valide." },
                    { role: "user", content: `Crée un plan de cours sur le thème "${theme}" pour un niveau "${level}" en ${numSessions} séances. Pour chaque séance, donne un titre, un objectif, des idées d'activités et des suggestions de ressources AIDA. Pour chaque ressource suggérée, fournis un objet JSON avec les clés "type" (choisi parmi "quiz", "exercices", "revision", "dm"), "sujet" (un titre court et descriptif), et "competence" (une compétence pédagogique précise et complète liée au sujet). La structure JSON finale doit être : { "planTitle": "...", "level": "...", "sessions": [{ "sessionNumber": 1, "title": "...", "objective": "...", "activities": ["..."], "resources": [{"type": "quiz", "sujet": "Les capitales européennes", "competence": "Localiser les principales capitales européennes sur une carte"}] }] }.` }
                ],
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json({ structured_plan: JSON.parse(response.data.choices[0].message.content) });
        } catch (error) {
            console.error("Erreur Deepseek (planificateur):", error.response?.data || error.message);
            res.status(500).json({ error: "Erreur lors de la génération du plan de cours." });
        }
    });

    // --- Correction copies ---
    router.post('/ai/grade-upload', upload.array('copies', 10), async (req, res) => {
        if (!formRecognizerClient || !process.env.DEEPSEEK_API_KEY) return res.status(503).json({ error: "Les services d'analyse IA ou Document ne sont pas configurés sur le serveur." });
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "Aucun fichier de copie n'a été reçu." });
        const { sujet, criteres } = req.body;
        if (!sujet || !criteres) return res.status(400).json({ error: "Le sujet et les critères de notation sont obligatoires." });
        try {
            const ocrPromises = req.files.map(async (file) => {
                const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", file.buffer);
                const { content } = await poller.pollUntilDone();
                return content;
            });
            const allTextSnippets = await Promise.all(ocrPromises);
            const fullText = allTextSnippets.join("\n\n--- PAGE SUIVANTE ---\n\n");
            const systemPrompt = `Tu es un assistant de correction expert pour enseignants. Tu reçois le SUJET d'un devoir, les CRITÈRES de notation, et le TEXTE COMPLET d'une copie d'élève. Ton objectif est de fournir une évaluation structurée et objective. Ta réponse DOIT être un objet JSON valide, et rien d'autre. Structure JSON ATTENDUE: { "analyseGlobale": "...", "criteres": [{ "nom": "...", "note": "X/Y", "commentaire": "..." }], "noteFinale": "X/20", "commentaireEleve": "..." }`;
            const userPrompt = `1. SUJET DU DEVOIR:\n"${sujet}"\n\n2. CRITÈRES DE NOTATION:\n"${criteres}"\n\n3. TEXTE COMPLET DE LA COPIE (extrait par OCR):\n"${fullText}"\n\nGénère l'évaluation JSON structurée correspondante.`;
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                response_format: { type: "json_object" }
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json(JSON.parse(response.data.choices[0].message.content));
        } catch (error) {
            console.error("Erreur dans le module d'aide à la correction:", error.response?.data || error.message);
            res.status(500).json({ error: "Erreur lors de l'analyse des copies." });
        }
    });

    // --- Aide AIDA modale ---
    router.post('/ai/get-aida-help', async (req, res) => {
        const { history, level } = req.body;
        if (!history) return res.status(400).json({ error: "L'historique de la conversation est manquant." });
        const systemPrompt = `Tu es AIDA, un tuteur IA bienveillant et pédagogue. Ton objectif est de guider les élèves vers la solution sans jamais donner la réponse directement. CONTEXTE : L'élève est au niveau [${level || 'non spécifié'}]. Utilise la méthode socratique.`;
        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: "deepseek-chat",
                messages: [{ role: "system", content: systemPrompt }, ...history]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
            res.json({ response: response.data.choices[0].message.content });
        } catch (error) {
            console.error("Erreur Deepseek (aide modale):", error.response?.data || error.message);
            res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA." });
        }
    });

    return router;
};
