const express = require('express');
const axios = require('axios');

module.exports = function ({ db }) {
    const router = express.Router();

    // ── GET my plan ────────────────────────────────────────────
    router.get('/parcours/my-plan', async (req, res) => {
        if (!db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        try {
            const { resource } = await db.parcoursContainer.item(req.user.email, req.user.email).read();
            res.json({ plan: resource ? resource.plan : null });
        } catch (e) {
            if (e.code === 404) return res.json({ plan: null });
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // ── POST generate diagnostic questions ─────────────────────
    router.post('/parcours/generate-diagnostic', async (req, res) => {
        const { gradeLevel, subjects } = req.body;
        if (!gradeLevel || !subjects?.length) return res.status(400).json({ error: "Niveau et matières requis." });

        const prompt = `Tu es un professeur expert en évaluation scolaire.
Crée un test de positionnement pour un élève de ${gradeLevel}.
Génère exactement 3 questions à choix multiples (QCM) par matière pour : ${subjects.join(', ')}.
Total : ${subjects.length * 3} questions. Mélange les matières.

Adapte la difficulté exactement au niveau ${gradeLevel} (programme officiel français).

JSON attendu :
{
  "questions": [
    {
      "subject": "Mathématiques",
      "question": "Texte de la question ?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0
    }
  ]
}`;

        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'Tu es un expert pédagogique. Réponds UNIQUEMENT avec du JSON valide, sans texte avant ni après.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            const data = JSON.parse(response.data.choices[0].message.content);
            res.json({ questions: data.questions });
        } catch (error) {
            console.error('Erreur diagnostic:', error.response?.data || error.message);
            res.status(500).json({ error: 'Erreur lors de la génération du diagnostic.' });
        }
    });

    // ── POST save plan (after diagnostic) ──────────────────────
    router.post('/parcours/save-plan', async (req, res) => {
        if (!db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        const { gradeLevel, subjects, scores } = req.body;
        if (!gradeLevel || !subjects?.length) return res.status(400).json({ error: "Données manquantes." });

        const scoresText = subjects.map(s => `${s} : ${scores[s] ?? 0}%`).join(', ');

        const prompt = `Tu es un coordinateur pédagogique expert.
Un élève de ${gradeLevel} vient de passer un test de positionnement.
Résultats : ${scoresText}

Crée un programme d'apprentissage personnalisé sur 4 semaines, adapté au programme scolaire français.

Règles :
- Matière avec score < 40% → 4 séances/semaine (prioritaire)
- Score 40-70% → 3 séances/semaine (à renforcer)
- Score > 70% → 2 séances/semaine (entretien)
- 3 à 5 compétences par matière, issues du programme de ${gradeLevel}
- weeklyHours : somme réaliste du temps par semaine (8-16h)

JSON attendu :
{
  "gradeLevel": "${gradeLevel}",
  "weeklyHours": 12,
  "subjects": [
    {
      "name": "Mathématiques",
      "weeklySessionCount": 3,
      "totalSessions": 12,
      "competences": [
        { "id": "c1", "label": "Fractions et décimaux", "status": "to_learn", "priority": 1 }
      ]
    }
  ],
  "schedule": {
    "Lundi": ["Mathématiques", "Français"],
    "Mardi": ["Histoire-Géographie"],
    "Mercredi": ["Mathématiques"],
    "Jeudi": ["Français", "Sciences"],
    "Vendredi": ["Révision"],
    "Samedi": [],
    "Dimanche": []
  }
}`;

        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'Tu es un expert pédagogique. Réponds UNIQUEMENT avec du JSON valide.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            plan.sessions = [];
            plan.createdAt = new Date().toISOString();

            await db.parcoursContainer.items.upsert({ id: req.user.email, userId: req.user.email, plan });
            res.json({ plan });
        } catch (error) {
            console.error('Erreur save-plan:', error.response?.data || error.message);
            res.status(500).json({ error: 'Erreur lors de la création du parcours.' });
        }
    });

    // ── POST start session (generate steps) ────────────────────
    router.post('/parcours/start-session', async (req, res) => {
        const { subject, competence, gradeLevel } = req.body;
        if (!subject || !competence) return res.status(400).json({ error: "Matière et compétence requises." });

        const prompt = `Tu es un tuteur IA pédagogue pour un élève de ${gradeLevel}.
Crée une séance d'apprentissage sur : "${competence}" en ${subject}.

Structure : 2 explications + 3 questions QCM = 5 étapes au total.

Règles :
- Les explications doivent être claires, engageantes, avec des exemples concrets
- Les questions doivent tester la compréhension (pas juste la mémorisation)
- Difficulté adaptée au niveau ${gradeLevel}

JSON attendu :
{
  "steps": [
    { "type": "explanation", "content": "Texte pédagogique clair. Utilise des exemples. 3-5 phrases." },
    { "type": "question", "question": "Question ?", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
    { "type": "explanation", "content": "Approfondissement ou astuce mémo." },
    { "type": "question", "question": "Question ?", "options": ["A", "B", "C", "D"], "correctIndex": 2 },
    { "type": "question", "question": "Question ?", "options": ["A", "B", "C", "D"], "correctIndex": 1 }
  ]
}`;

        try {
            const response = await axios.post('https://api.deepseek.com/chat/completions', {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: 'Tu es un tuteur pédagogique. Réponds UNIQUEMENT avec du JSON valide.' },
                    { role: 'user', content: prompt }
                ],
                response_format: { type: 'json_object' }
            }, { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

            const data = JSON.parse(response.data.choices[0].message.content);
            res.json({ steps: data.steps });
        } catch (error) {
            console.error('Erreur start-session:', error.response?.data || error.message);
            res.status(500).json({ error: 'Erreur lors du démarrage de la séance.' });
        }
    });

    // ── POST log session ────────────────────────────────────────
    router.post('/parcours/log-session', async (req, res) => {
        if (!db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        const { subject, competence, score, date, duration } = req.body;

        try {
            const { resource: doc } = await db.parcoursContainer.item(req.user.email, req.user.email).read();
            if (!doc) return res.status(404).json({ error: "Parcours introuvable." });

            doc.plan.sessions = doc.plan.sessions || [];
            doc.plan.sessions.push({
                id: `sess-${Date.now()}`,
                subject, competence, score, date, duration,
                status: 'completed'
            });

            // Mark competence as mastered if score >= 70
            if (score >= 70) {
                const subData = doc.plan.subjects?.find(s => s.name === subject);
                const comp = subData?.competences?.find(c => c.label === competence);
                if (comp) comp.status = 'mastered';
            }

            await db.parcoursContainer.items.upsert(doc);
            res.json({ plan: doc.plan });
        } catch (e) {
            res.status(500).json({ error: "Erreur lors de l'enregistrement." });
        }
    });

    // ── DELETE reset plan ───────────────────────────────────────
    router.delete('/parcours/reset', async (req, res) => {
        if (!db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        try {
            await db.parcoursContainer.item(req.user.email, req.user.email).delete();
        } catch (e) { /* already gone */ }
        res.json({ ok: true });
    });

    return router;
};
