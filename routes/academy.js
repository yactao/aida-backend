const express = require('express');
const axios = require('axios');

module.exports = function ({ db, ttsClient, defaultScenarios }) {
    const router = express.Router();

    // --- Badge / Achievement ---
    router.post('/academy/achievement/unlock', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { userId, badgeId } = req.body;
        if (!userId || !badgeId) return res.status(400).json({ error: "userId et badgeId sont requis." });
        try {
            const { resource: user } = await db.usersContainer.item(userId, userId).read();
            if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
            user.achievements = user.achievements || [];
            if (user.achievements.includes(badgeId)) {
                delete user.password;
                return res.json({ message: "Badge déjà possédé.", user });
            }
            user.achievements.push(badgeId);
            const { resource: updatedUser } = await db.usersContainer.item(userId, userId).replace(user);
            delete updatedUser.password;
            res.status(201).json({ message: "Badge débloqué !", badgeId, user: updatedUser });
        } catch (error) {
            console.error("Erreur lors du déblocage du badge:", error);
            res.status(500).json({ error: "Erreur du serveur." });
        }
    });

    // --- Synthese vocale ---
    router.post('/ai/synthesize-speech', async (req, res) => {
        if (!ttsClient) return res.status(500).json({ error: "Le service de synthèse vocale n'est pas configuré sur le serveur." });
        const { text, voice, rate, pitch } = req.body;
        if (!text) return res.status(400).json({ error: "Le texte est manquant." });
        const cleanedText = text
            .replace(/([\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}])/gu, '')
            .replace(/[*#_`]/g, '');
        const request = {
            input: { text: cleanedText },
            voice: { languageCode: voice ? voice.substring(0, 5) : 'fr-FR', name: voice || 'fr-FR-Wavenet-E' },
            audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) || 1.0, pitch: parseFloat(pitch) || 0.0 }
        };
        try {
            const [response] = await ttsClient.synthesizeSpeech(request);
            res.json({ audioContent: response.audioContent.toString('base64') });
        } catch (error) {
            console.error("Erreur lors de la synthèse vocale Google:", error);
            res.status(500).json({ error: "Impossible de générer l'audio." });
        }
    });

    // --- Chat IA immersif ---
    router.post('/academy/ai/chat', async (req, res) => {
        const { history, response_format } = req.body;
        if (!history) return res.status(400).json({ error: "L'historique de la conversation est manquant." });
        try {
            const deepseekBody = { model: "deepseek-chat", messages: history };
            if (response_format) deepseekBody.response_format = response_format;
            const response = await axios.post('https://api.deepseek.com/chat/completions', deepseekBody, {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' }
            });
            res.json({ reply: response.data.choices[0].message.content });
        } catch (error) {
            console.error("Erreur Deepseek (Académie MRE):", error.response?.data || error.message);
            res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA pour l'Académie." });
        }
    });

    // --- Sauvegarde session ---
    router.post('/academy/session/save', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { scenarioId, report, fullHistory } = req.body;
        const userId = req.user.email;
        if (!userId || !scenarioId || !report) return res.status(400).json({ error: "Données de session incomplètes." });
        const newSession = {
            id: `session-${Date.now()}-${userId}`,
            userId, scenarioId,
            completedAt: new Date().toISOString(),
            report, fullHistory
        };
        try {
            const { resource: user } = await db.usersContainer.item(userId, userId).read();
            if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
            user.academyProgress = user.academyProgress || {};
            user.academyProgress.sessions = user.academyProgress.sessions || [];
            user.academyProgress.sessions.push(newSession);
            await db.usersContainer.items.upsert(user);
            res.status(201).json({ message: "Session enregistrée avec succès.", sessionId: newSession.id });
        } catch (error) {
            console.error("Erreur lors de la sauvegarde de la session Académie:", error.message);
            res.status(500).json({ error: "Erreur serveur lors de la sauvegarde de la session." });
        }
    });

    // --- Scenarios ---
    router.get('/academy/scenarios', async (req, res) => {
        if (!db.scenariosContainer) return res.json(defaultScenarios);
        try {
            const { resources: dbScenarios } = await db.scenariosContainer.items.readAll().fetchAll();
            if (dbScenarios.length === 0) return res.json(defaultScenarios);
            const allScenariosMap = new Map();
            defaultScenarios.forEach(s => allScenariosMap.set(s.id, s));
            dbScenarios.forEach(s => allScenariosMap.set(s.id, s));
            res.json(Array.from(allScenariosMap.values()));
        } catch (error) {
            console.error("Erreur lors de la lecture des scénarios:", error.message);
            res.json(defaultScenarios);
        }
    });

    router.post('/academy/scenarios/create', async (req, res) => {
        if (!db.scenariosContainer) return res.status(503).json({ error: "Conteneur de scénarios non disponible." });
        const newScenario = req.body;
        if (!newScenario.title || !newScenario.characterIntro) return res.status(400).json({ error: "Les données de scénario sont incomplètes." });
        const scenarioToInsert = {
            id: `scen-${Date.now()}`,
            voiceCode: newScenario.voiceCode || 'ar-XA-Wavenet-B',
            createdAt: new Date().toISOString(),
            ...newScenario
        };
        try {
            const { resource: createdScenario } = await db.scenariosContainer.items.create(scenarioToInsert);
            res.status(201).json({ message: "Scénario créé avec succès.", scenario: createdScenario });
        } catch (error) {
            console.error("Erreur lors de la création du scénario:", error.message);
            res.status(500).json({ error: "Erreur serveur lors de la création du scénario." });
        }
    });

    // --- Suivi enseignant academie ---
    router.get('/academy/teacher/students', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const querySpec = {
            query: "SELECT c.id, c.firstName, c.academyProgress FROM c WHERE c.role = @role",
            parameters: [{ name: "@role", value: "academy_student" }]
        };
        try {
            const { resources: students } = await db.usersContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
            res.json(students);
        } catch (error) {
            console.error("Erreur lors de la récupération des élèves de l'académie:", error.message);
            res.status(500).json({ error: "Erreur serveur lors de la récupération des élèves." });
        }
    });

    return router;
};
