const express = require('express');
const axios = require('axios');

module.exports = function ({ db, bcrypt, jwt, jwtSecret }) {
    const router = express.Router();

    const PARCOURS_ROLES = ['parcours_student', 'parcours_tutor', 'parcours_parent'];

    function generateStudentCode(firstName) {
        const clean = (firstName || 'ELEVE').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'ELEVE';
        const num = Math.floor(1000 + Math.random() * 9000);
        return `${clean}-${num}`;
    }

    // ── POST /parcours/auth/signup ─────────────────────────── PUBLIC
    router.post('/parcours/auth/signup', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        const { firstName, email, password, role, gradeLevel, tutorStatus } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) return res.status(400).json({ error: "Email invalide." });
        if (!password || password.length < 6) return res.status(400).json({ error: "Mot de passe trop court (6 caractères min)." });
        if (!PARCOURS_ROLES.includes(role)) return res.status(400).json({ error: "Rôle invalide." });
        if (!firstName || firstName.trim().length < 2) return res.status(400).json({ error: "Prénom requis." });

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const newUser = {
                id: email, email,
                password: hashedPassword,
                role,
                firstName: firstName.trim(),
                avatar: 'default.png',
                createdAt: new Date().toISOString()
            };
            if (role === 'parcours_student') {
                newUser.parcoursCode = generateStudentCode(firstName);
                newUser.gradeLevel = gradeLevel || '';
                newUser.linkedTutors = [];
                newUser.linkedParents = [];
            }
            if (role === 'parcours_tutor') {
                newUser.tutorStatus = tutorStatus || 'other';
                newUser.linkedStudents = [];
            }
            if (role === 'parcours_parent') {
                newUser.linkedStudents = [];
            }
            const { resource: created } = await db.usersContainer.items.create(newUser);
            delete created.password;
            const token = jwt.sign({ email: created.email, role: created.role }, jwtSecret, { expiresIn: '30d' });
            res.status(201).json({ user: created, token });
        } catch (e) {
            if (e.code === 409) return res.status(409).json({ error: "Cet email est déjà utilisé." });
            res.status(500).json({ error: "Erreur lors de la création du compte." });
        }
    });

    // ── POST /parcours/auth/login ──────────────────────────── PUBLIC
    router.post('/parcours/auth/login', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Email et mot de passe requis." });
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            if (!user || !PARCOURS_ROLES.includes(user.role)) return res.status(401).json({ error: "Compte introuvable." });
            const match = await bcrypt.compare(password, user.password);
            if (!match) return res.status(401).json({ error: "Mot de passe incorrect." });
            delete user.password;
            const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '30d' });
            res.json({ user, token });
        } catch (e) {
            if (e.code === 404) return res.status(401).json({ error: "Compte introuvable." });
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // ── POST /parcours/link-student ────────────────────────── AUTH
    router.post('/parcours/link-student', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service indisponible." });
        const { studentCode } = req.body;
        const linkerEmail = req.user.email;
        const linkerRole = req.user.role;
        if (!['parcours_tutor', 'parcours_parent'].includes(linkerRole)) {
            return res.status(403).json({ error: "Seuls les tuteurs et parents peuvent lier un élève." });
        }
        if (!studentCode) return res.status(400).json({ error: "Code élève requis." });
        try {
            // Find student by parcoursCode
            const query = { query: "SELECT * FROM c WHERE c.parcoursCode = @code", parameters: [{ name: "@code", value: studentCode.trim().toUpperCase() }] };
            const { resources } = await db.usersContainer.items.query(query).fetchAll();
            if (!resources.length) return res.status(404).json({ error: "Aucun élève trouvé avec ce code." });
            const student = resources[0];

            // Link linker → student
            const { resource: linker } = await db.usersContainer.item(linkerEmail, linkerEmail).read();
            if (!linker.linkedStudents.includes(student.email)) {
                linker.linkedStudents.push(student.email);
                await db.usersContainer.items.upsert(linker);
            }

            // Link student → linker
            const field = linkerRole === 'parcours_tutor' ? 'linkedTutors' : 'linkedParents';
            student[field] = student[field] || [];
            if (!student[field].includes(linkerEmail)) {
                student[field].push(linkerEmail);
                await db.usersContainer.items.upsert(student);
            }

            res.json({ student: { email: student.email, firstName: student.firstName, gradeLevel: student.gradeLevel, parcoursCode: student.parcoursCode } });
        } catch (e) {
            console.error('link-student error:', e);
            res.status(500).json({ error: "Erreur lors de la liaison." });
        }
    });

    // ── GET /parcours/my-students ──────────────────────────── AUTH (tutor/parent)
    router.get('/parcours/my-students', async (req, res) => {
        if (!db.usersContainer || !db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        const role = req.user.role;
        if (!['parcours_tutor', 'parcours_parent'].includes(role)) return res.status(403).json({ error: "Accès refusé." });
        try {
            const { resource: me } = await db.usersContainer.item(req.user.email, req.user.email).read();
            const emails = me.linkedStudents || [];
            const students = await Promise.all(emails.map(async (email) => {
                try {
                    const { resource: student } = await db.usersContainer.item(email, email).read();
                    if (!student) return null;
                    let plan = null;
                    try {
                        const { resource: doc } = await db.parcoursContainer.item(email, email).read();
                        if (doc) plan = doc.plan;
                    } catch {}
                    const completedSessions = (plan?.sessions || []).filter(s => s.status === 'completed').length;
                    const lastSession = (plan?.sessions || []).slice(-1)[0];
                    return {
                        email: student.email,
                        firstName: student.firstName,
                        avatar: student.avatar,
                        gradeLevel: student.gradeLevel,
                        parcoursCode: student.parcoursCode,
                        hasPlan: !!plan,
                        completedSessions,
                        lastSessionDate: lastSession?.date || null,
                        subjects: plan?.subjects?.map(s => s.name) || []
                    };
                } catch { return null; }
            }));
            res.json({ students: students.filter(Boolean) });
        } catch (e) {
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    // ── GET /parcours/student-plan/:email ──────────────────── AUTH (tutor/parent)
    router.get('/parcours/student-plan/:email', async (req, res) => {
        if (!db.usersContainer || !db.parcoursContainer) return res.status(503).json({ error: "Service indisponible." });
        const viewerRole = req.user.role;
        if (!['parcours_tutor', 'parcours_parent'].includes(viewerRole)) return res.status(403).json({ error: "Accès refusé." });
        const studentEmail = decodeURIComponent(req.params.email);
        try {
            // Verify linker has access to this student
            const { resource: viewer } = await db.usersContainer.item(req.user.email, req.user.email).read();
            if (!viewer.linkedStudents?.includes(studentEmail)) return res.status(403).json({ error: "Cet élève n'est pas lié à votre compte." });
            const { resource: student } = await db.usersContainer.item(studentEmail, studentEmail).read();
            const { resource: doc } = await db.parcoursContainer.item(studentEmail, studentEmail).read().catch(() => ({ resource: null }));
            delete student.password;
            res.json({ student, plan: doc?.plan || null });
        } catch (e) {
            if (e.code === 404) return res.status(404).json({ error: "Élève introuvable." });
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

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
