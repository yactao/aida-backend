const express = require('express');
const axios = require('axios');

async function pushNotification(db, email, notification) {
    try {
        const { resource: user } = await db.usersContainer.item(email, email).read();
        user.notifications = user.notifications || [];
        user.notifications.unshift({ id: `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, ...notification, read: false, createdAt: new Date().toISOString() });
        if (user.notifications.length > 50) user.notifications = user.notifications.slice(0, 50);
        await db.usersContainer.items.upsert(user);
    } catch (e) { /* non-blocking */ }
}

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

    // --- Sauvegarde session (Sessions container séparé) ---
    router.post('/academy/session/save', async (req, res) => {
        if (!db.sessionsContainer || !db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { scenarioId, report, fullHistory } = req.body;
        const userId = req.user.email;
        if (!userId || !scenarioId || !report) return res.status(400).json({ error: "Données de session incomplètes." });
        const newSession = {
            id: `session-${Date.now()}-${userId.replace('@', '-').replace('.', '-')}`,
            userId, scenarioId,
            completedAt: new Date().toISOString(),
            report, fullHistory: fullHistory || []
        };
        try {
            // 1. Stocker la session dans le container dédié
            await db.sessionsContainer.items.create(newSession);

            // 2. Mettre à jour uniquement le résumé léger sur le user (pas de fullHistory)
            const { resource: user } = await db.usersContainer.item(userId, userId).read();
            user.academyProgress = user.academyProgress || {};
            user.academyProgress.totalSessions = (user.academyProgress.totalSessions || 0) + 1;
            user.academyProgress.lastActivity = newSession.completedAt;
            await db.usersContainer.items.upsert(user);

            res.status(201).json({ message: "Session enregistrée.", sessionId: newSession.id, totalSessions: user.academyProgress.totalSessions });
        } catch (error) {
            console.error("Erreur lors de la sauvegarde de la session Académie:", error.message);
            res.status(500).json({ error: "Erreur serveur lors de la sauvegarde de la session." });
        }
    });

    // --- Récupérer les sessions de l'utilisateur connecté ---
    router.get('/academy/sessions', async (req, res) => {
        if (!db.sessionsContainer) return res.status(503).json({ error: "Service indisponible." });
        const userId = req.user.email;
        try {
            const { resources } = await db.sessionsContainer.items.query(
                { query: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.completedAt DESC", parameters: [{ name: "@userId", value: userId }] },
                { partitionKey: userId }
            ).fetchAll();
            res.json(resources);
        } catch (error) {
            console.error("Erreur lors de la récupération des sessions:", error.message);
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // --- Sessions d'un élève (pour enseignant/parent) ---
    router.get('/academy/student-sessions', async (req, res) => {
        if (!db.sessionsContainer || !db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        const requestorRole = req.user.role;
        if (!['academy_teacher', 'academy_parent'].includes(requestorRole)) return res.status(403).json({ error: "Accès refusé." });
        const studentId = req.query.studentId;
        try {
            const { resources } = await db.sessionsContainer.items.query(
                { query: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.completedAt DESC", parameters: [{ name: "@userId", value: studentId }] },
                { partitionKey: studentId }
            ).fetchAll();
            res.json(resources);
        } catch (error) {
            console.error("Erreur lors de la récupération des sessions élève:", error.message);
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // --- Scenarios ---
    router.get('/academy/scenarios', async (req, res) => {
        if (!db.scenariosContainer) return res.json(defaultScenarios);
        const isStudent = req.user?.role === 'academy_student';
        try {
            const { resources: dbScenarios } = await db.scenariosContainer.items.readAll().fetchAll();
            if (dbScenarios.length === 0) return res.json(defaultScenarios);
            const allScenariosMap = new Map();
            defaultScenarios.forEach(s => allScenariosMap.set(s.id, s));
            // Students only see scenarios explicitly marked public or created by any teacher
            // Teachers/parents see all scenarios (including their own)
            dbScenarios.forEach(s => {
                if (!isStudent || s.isPublic || s.createdBy) {
                    allScenariosMap.set(s.id, s);
                }
            });
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
            createdBy: req.user.email,
            isPublic: true,
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

    // --- Code de classe enseignant ---

    // GET /api/academy/teacher/class-code — retourne (ou génère) le code de classe
    router.get('/academy/teacher/class-code', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        if (req.user.role !== 'academy_teacher') return res.status(403).json({ error: "Réservé aux enseignants." });
        try {
            const { resource: teacher } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (!teacher.classCode) {
                const crypto = require('crypto');
                teacher.classCode = crypto.randomBytes(3).toString('hex').toUpperCase();
                await db.usersContainer.items.upsert(teacher);
            }
            res.json({ classCode: teacher.classCode });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/academy/join-class — l'élève rejoint une classe via le code
    router.post('/academy/join-class', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        if (req.user.role !== 'academy_student') return res.status(403).json({ error: "Réservé aux élèves." });
        const { classCode } = req.body;
        if (!classCode) return res.status(400).json({ error: "Code de classe requis." });

        try {
            // Chercher l'enseignant avec ce code
            const { resources: teachers } = await db.usersContainer.items.query(
                {
                    query: "SELECT c.id, c.email, c.firstName FROM c WHERE c.role = 'academy_teacher' AND c.classCode = @code",
                    parameters: [{ name: "@code", value: classCode.toUpperCase() }]
                },
                { enableCrossPartitionQuery: true }
            ).fetchAll();

            if (teachers.length === 0) return res.status(404).json({ error: "Code de classe invalide ou introuvable." });

            const teacher = teachers[0];

            // Lier l'élève à ce teacher
            const { resource: student } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (student.linkedTeacherCode === classCode.toUpperCase()) {
                return res.json({ message: "Vous êtes déjà dans cette classe.", teacherName: teacher.firstName });
            }
            student.linkedTeacherCode = classCode.toUpperCase();
            student.linkedTeacherEmail = teacher.email;
            await db.usersContainer.items.upsert(student);

            res.json({ message: `Vous avez rejoint la classe de ${teacher.firstName} !`, teacherName: teacher.firstName });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/academy/leave-class — l'élève quitte sa classe
    router.post('/academy/leave-class', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        if (req.user.role !== 'academy_student') return res.status(403).json({ error: "Réservé aux élèves." });
        try {
            const { resource: student } = await db.usersContainer.item(req.user.email, req.user.email).read();
            delete student.linkedTeacherCode;
            delete student.linkedTeacherEmail;
            await db.usersContainer.items.upsert(student);
            res.json({ message: "Vous avez quitté la classe." });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/academy/teacher/add-student — l'enseignant ajoute un élève existant par email
    router.post('/academy/teacher/add-student', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        if (req.user.role !== 'academy_teacher') return res.status(403).json({ error: "Réservé aux enseignants." });
        const { studentEmail } = req.body;
        if (!studentEmail) return res.status(400).json({ error: "Email de l'élève requis." });

        try {
            const { resource: teacher } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (!teacher.classCode) {
                const crypto = require('crypto');
                teacher.classCode = crypto.randomBytes(3).toString('hex').toUpperCase();
                await db.usersContainer.items.upsert(teacher);
            }

            const { resource: student } = await db.usersContainer.item(studentEmail, studentEmail).read();
            if (!student) return res.status(404).json({ error: "Aucun compte trouvé avec cet email." });
            if (student.role !== 'academy_student') return res.status(400).json({ error: "Ce compte n'est pas un élève Academy." });

            student.linkedTeacherCode = teacher.classCode;
            student.linkedTeacherEmail = req.user.email;
            await db.usersContainer.items.upsert(student);

            res.json({ message: `${student.firstName} a été ajouté à votre classe.`, student: { id: student.id, firstName: student.firstName, email: student.email } });
        } catch (e) {
            if (e.code === 404) return res.status(404).json({ error: "Élève introuvable." });
            res.status(500).json({ error: e.message });
        }
    });

    // --- Suivi enseignant académie (résumé léger, sans sessions complètes) ---
    router.get('/academy/teacher/students', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        if (req.user.role !== 'academy_teacher') return res.status(403).json({ error: "Réservé aux enseignants." });

        try {
            const { resource: teacher } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (!teacher.classCode) return res.json([]);

            const querySpec = {
                query: "SELECT c.id, c.firstName, c.email, c.avatar, c.achievements, c.academyProgress FROM c WHERE c.role = 'academy_student' AND c.linkedTeacherCode = @code",
                parameters: [{ name: "@code", value: teacher.classCode }]
            };
            const { resources: students } = await db.usersContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
            res.json(students);
        } catch (error) {
            res.status(500).json({ error: "Erreur serveur lors de la récupération des élèves." });
        }
    });

    // --- Leçon personnalisée par intérêt ---
    router.post('/academy/interest-lesson', async (req, res) => {
        const { interest, level } = req.body;
        if (!interest) return res.status(400).json({ error: "Intérêt requis." });

        const levelDescriptions = {
            alif:   'débutant absolu (alphabet + mots très simples)',
            racine: 'débutant (phrases courtes, présent)',
            oasis:  'intermédiaire (phrases complexes, passé/futur)',
            heros:  'avancé (texte riche, nuances culturelles)',
        };
        const levelDesc = levelDescriptions[level] || levelDescriptions.racine;

        const systemPrompt = `Tu es AÏDA, tuteur expert en arabe littéraire. Tu génères des leçons structurées en JSON strict. Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte avant ou après.`;

        const userPrompt = `Génère une leçon d'arabe littéraire sur le thème "${interest}" pour un apprenant de niveau ${levelDesc}.

La réponse DOIT être un JSON avec exactement cette structure :
{
  "theme": "${interest}",
  "titre": "titre accrocheur de la leçon en français",
  "vocab": [
    { "arabe": "...", "phonetique": "...", "francais": "..." }
  ],
  "dialogue": {
    "titre": "titre de la scène en français",
    "echanges": [
      { "locuteur": "A", "arabe": "...", "phonetique": "...", "francais": "..." },
      { "locuteur": "B", "arabe": "...", "phonetique": "...", "francais": "..." }
    ]
  },
  "astuce": "astuce culturelle ou grammaticale liée au thème (1-2 phrases)"
}

Règles :
- vocab : exactement 6 mots/expressions, du plus simple au plus complexe
- dialogue : 4 à 6 échanges naturels, contexte lié au thème
- L'arabe doit être en script arabe avec les voyelles (تشكيل) pour le niveau ${levelDesc}
- La phonétique doit utiliser la translittération française (ex: "marhaban" pas "mar7aban")`;

        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            const lesson = JSON.parse(response.data.choices[0].message.content);
            res.json(lesson);
        } catch (err) {
            console.error('Erreur interest-lesson:', err.response?.data || err.message);
            res.status(500).json({ error: 'Erreur lors de la génération de la leçon.' });
        }
    });

    // ── GET teacher info by student's linkedTeacherCode ──────────────────────
    router.get('/academy/teacher/by-code', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        if (req.user.role !== 'academy_student') return res.status(403).json({ error: "Réservé aux élèves." });
        try {
            const { resource: student } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (!student.linkedTeacherCode) return res.status(404).json({ error: "Aucun enseignant lié." });
            const { resources } = await db.usersContainer.items.query({
                query: "SELECT c.id, c.email, c.firstName FROM c WHERE c.role = 'academy_teacher' AND c.classCode = @code",
                parameters: [{ name: '@code', value: student.linkedTeacherCode }]
            }, { enableCrossPartitionQuery: true }).fetchAll();
            if (!resources.length) return res.status(404).json({ error: "Enseignant introuvable." });
            res.json(resources[0]);
        } catch (e) {
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // ── MESSAGING ────────────────────────────────────────────────────────────
    async function canMessageAcademy(emailA, roleA, emailB, roleB) {
        try {
            const teacherEmail = roleA === 'academy_teacher' ? emailA : (roleB === 'academy_teacher' ? emailB : null);
            const otherEmail = roleA === 'academy_teacher' ? emailB : emailA;
            if (!teacherEmail) return false;
            const { resource: teacher } = await db.usersContainer.item(teacherEmail, teacherEmail).read();
            if (!teacher?.classCode) return false;
            const { resource: other } = await db.usersContainer.item(otherEmail, otherEmail).read();
            if (other?.role === 'academy_student') return other.linkedTeacherCode === teacher.classCode;
            if (other?.role === 'academy_parent') {
                for (const sEmail of (other.linkedStudents || [])) {
                    const { resource: s } = await db.usersContainer.item(sEmail, sEmail).read().catch(() => ({ resource: null }));
                    if (s?.linkedTeacherCode === teacher.classCode) return true;
                }
            }
            return false;
        } catch { return false; }
    }

    router.get('/academy/messages/threads', async (req, res) => {
        if (!db.eduMessagesContainer) return res.status(503).json({ error: "Service indisponible." });
        const myEmail = req.user.email;
        try {
            const { resources } = await db.eduMessagesContainer.items.query({
                query: 'SELECT * FROM c WHERE CONTAINS(c.threadId, @email) AND c.context = "academy" ORDER BY c.timestamp DESC',
                parameters: [{ name: '@email', value: myEmail }]
            }, { enableCrossPartitionQuery: true }).fetchAll();

            const threadMap = new Map();
            for (const msg of resources) {
                if (!threadMap.has(msg.threadId)) {
                    const otherEmail = msg.threadId.split(':').find(e => e !== myEmail);
                    threadMap.set(msg.threadId, { threadId: msg.threadId, otherEmail, lastMessage: msg.content, timestamp: msg.timestamp, fromName: msg.fromName, fromEmail: msg.fromEmail });
                }
            }
            res.json({ threads: [...threadMap.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)) });
        } catch (e) { res.status(500).json({ error: "Erreur serveur." }); }
    });

    router.get('/academy/messages/thread/:otherEmail', async (req, res) => {
        if (!db.eduMessagesContainer) return res.status(503).json({ error: "Service indisponible." });
        const me = req.user;
        const otherEmail = decodeURIComponent(req.params.otherEmail);
        try {
            const { resource: other } = await db.usersContainer.item(otherEmail, otherEmail).read();
            if (!await canMessageAcademy(me.email, me.role, otherEmail, other.role))
                return res.status(403).json({ error: "Accès refusé." });
            const threadId = [me.email, otherEmail].sort().join(':');
            const { resources } = await db.eduMessagesContainer.items.query({
                query: 'SELECT * FROM c WHERE c.threadId = @tid ORDER BY c.timestamp ASC',
                parameters: [{ name: '@tid', value: threadId }]
            }, { enableCrossPartitionQuery: true }).fetchAll();
            res.json({ messages: resources });
        } catch (e) {
            if (e.code === 404) return res.status(404).json({ error: "Utilisateur introuvable." });
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    router.post('/academy/messages/thread/:otherEmail', async (req, res) => {
        if (!db.eduMessagesContainer) return res.status(503).json({ error: "Service indisponible." });
        const me = req.user;
        const otherEmail = decodeURIComponent(req.params.otherEmail);
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: "Message vide." });
        try {
            const { resource: other } = await db.usersContainer.item(otherEmail, otherEmail).read();
            if (!await canMessageAcademy(me.email, me.role, otherEmail, other.role))
                return res.status(403).json({ error: "Accès refusé." });
            const threadId = [me.email, otherEmail].sort().join(':');
            const msg = {
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                threadId, context: 'academy',
                fromEmail: me.email, fromName: me.firstName || me.email, fromRole: me.role,
                content: content.trim(), timestamp: new Date().toISOString()
            };
            await db.eduMessagesContainer.items.create(msg);
            pushNotification(db, otherEmail, { type: 'new_message', message: `Nouveau message de ${me.firstName || me.email}.` });
            res.status(201).json({ message: msg });
        } catch (e) {
            if (e.code === 404) return res.status(404).json({ error: "Utilisateur introuvable." });
            res.status(500).json({ error: "Erreur lors de l'envoi." });
        }
    });

    return router;
};
