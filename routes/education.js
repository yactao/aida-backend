const express = require('express');
const nodemailer = require('nodemailer');

function createMailTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

async function pushNotification(db, email, notification) {
    try {
        const { resource: user } = await db.usersContainer.item(email, email).read();
        user.notifications = user.notifications || [];
        user.notifications.unshift({ id: `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, ...notification, read: false, createdAt: new Date().toISOString() });
        if (user.notifications.length > 50) user.notifications = user.notifications.slice(0, 50);
        await db.usersContainer.items.upsert(user);
    } catch (e) { /* non-blocking */ }
}

module.exports = function ({ db }) {
    const router = express.Router();

    // --- Teacher routes ---

    router.get('/teacher/classes', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const teacherEmail = req.user.email;
        const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
        try {
            const { resources: classes } = await db.classesContainer.items.query(querySpec).fetchAll();
            res.json(classes);
        } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
    });

    router.post('/teacher/classes', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { className } = req.body;
        const teacherEmail = req.user.email;
        const newClass = { className, teacherEmail, id: `class-${Date.now()}`, students: [], content: [], results: [] };
        try {
            const { resource: createdClass } = await db.classesContainer.items.create(newClass);
            res.status(201).json(createdClass);
        } catch (error) { res.status(500).json({ error: "Erreur lors de la création de la classe." }); }
    });

    router.get('/teacher/classes/:id', async (req, res) => {
        if (!db.classesContainer || !db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const teacherEmail = req.user.email;
        try {
            const { resource: classData } = await db.classesContainer.item(req.params.id, teacherEmail).read();
            if (!classData) return res.status(404).json({ error: 'Classe introuvable' });
            if (classData.students && classData.students.length > 0) {
                const querySpec = { query: `SELECT c.email, c.firstName, c.avatar FROM c WHERE ARRAY_CONTAINS(@studentEmails, c.email)`, parameters: [{ name: '@studentEmails', value: classData.students }] };
                const { resources: studentsDetails } = await db.usersContainer.items.query(querySpec).fetchAll();
                classData.studentsWithDetails = studentsDetails;
            } else {
                classData.studentsWithDetails = [];
            }
            res.json(classData);
        } catch (error) {
            if (error.code === 404) return res.status(404).json({ error: 'Classe introuvable' });
            res.status(500).json({ error: "Impossible de récupérer les détails de la classe." });
        }
    });

    router.post('/teacher/classes/:id/add-student', async (req, res) => {
        if (!db.classesContainer || !db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { studentEmail } = req.body;
        const teacherEmail = req.user.email;
        const { id: classId } = req.params;
        try {
            const { resource: student } = await db.usersContainer.item(studentEmail, studentEmail).read();
            if (!student || student.role !== 'student') return res.status(404).json({ error: "Élève introuvable ou l'email n'est pas un compte élève." });
            const { resource: classData } = await db.classesContainer.item(classId, teacherEmail).read();
            if (classData.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });
            classData.students.push(studentEmail);
            await db.classesContainer.items.upsert(classData);
            res.status(200).json(classData);
        } catch (error) {
            if (error.code === 404) return res.status(404).json({ error: "Élève ou classe introuvable." });
            res.status(500).json({ error: "Erreur serveur." });
        }
    });

    router.post('/teacher/assign-content', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId, contentData } = req.body;
        const teacherEmail = req.user.email;
        const newContent = { ...contentData, id: `content-${Date.now()}`, assignedAt: new Date().toISOString() };
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            if (!classDoc) return res.status(404).json({ error: 'Classe introuvable' });
            classDoc.content = classDoc.content || [];
            classDoc.content.push(newContent);
            await db.classesContainer.items.upsert(classDoc);
            res.status(200).json(newContent);
            // Notify each student (non-blocking)
            (classDoc.students || []).forEach(email => {
                pushNotification(db, email, { type: 'new_content', message: `Nouveau devoir dans "${classDoc.className}" : ${newContent.title || newContent.type}` });
            });
        } catch (error) { res.status(500).json({ error: "Erreur lors de l'assignation." }); }
    });

    router.post('/teacher/classes/:classId/generate-invite', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId } = req.params;
        const teacherEmail = req.user.email;
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            if (!classDoc) return res.status(404).json({ error: 'Classe introuvable.' });
            // Generate a short alphanumeric code (XXX-YYY format)
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const part = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            classDoc.inviteCode = `${part(3)}-${part(3)}`;
            await db.classesContainer.items.upsert(classDoc);
            res.json({ inviteCode: classDoc.inviteCode });
        } catch (error) {
            if (error.code === 404) return res.status(404).json({ error: 'Classe introuvable.' });
            res.status(500).json({ error: "Erreur lors de la génération du code." });
        }
    });

    router.post('/teacher/classes/:classId/send-invite-email', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId } = req.params;
        const { studentEmail } = req.body;
        const teacherEmail = req.user.email;
        if (!studentEmail) return res.status(400).json({ error: "Email de l'élève requis." });
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            if (!classDoc) return res.status(404).json({ error: 'Classe introuvable.' });
            if (!classDoc.inviteCode) return res.status(400).json({ error: "Générez d'abord un code d'invitation." });

            const appUrl = process.env.APP_URL || 'https://gray-meadow-0061b3603.1.azurestaticapps.net';
            const joinLink = `${appUrl}?action=join-class&code=${classDoc.inviteCode}`;

            const transporter = createMailTransporter();
            await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to: studentEmail,
                subject: `Invitation à rejoindre la classe "${classDoc.className}" sur AÏDA`,
                html: `
                    <div style="font-family:sans-serif;max-width:500px;margin:auto;">
                        <h2 style="color:#6366F1;">AÏDA Éducation</h2>
                        <p>Bonjour,</p>
                        <p>Votre enseignant vous invite à rejoindre la classe <strong>${classDoc.className}</strong>.</p>
                        <p style="margin:1.5rem 0;">Votre code d'invitation :</p>
                        <div style="font-size:2rem;font-weight:800;letter-spacing:0.2em;color:#6366F1;background:#F8F7FF;border:2px dashed #6366F1;border-radius:12px;padding:1rem 2rem;display:inline-block;">${classDoc.inviteCode}</div>
                        <p style="margin-top:1.5rem;">Ou cliquez directement sur ce lien :</p>
                        <a href="${joinLink}" style="display:inline-block;padding:12px 24px;background:#6366F1;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Rejoindre la classe</a>
                        <p style="color:#888;font-size:12px;margin-top:24px;">Connectez-vous d'abord à AÏDA Éducation, puis entrez le code dans votre tableau de bord.</p>
                    </div>`
            });
            res.json({ message: "Invitation envoyée avec succès." });
        } catch (error) {
            if (error.code === 404) return res.status(404).json({ error: 'Classe introuvable.' });
            console.error("Erreur envoi invitation:", error.message);
            res.status(500).json({ error: "Erreur lors de l'envoi de l'email." });
        }
    });

    router.post('/student/join-class', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { inviteCode } = req.body;
        const studentEmail = req.user.email;
        if (!inviteCode) return res.status(400).json({ error: "Code d'invitation requis." });
        try {
            const querySpec = {
                query: "SELECT * FROM c WHERE c.inviteCode = @code",
                parameters: [{ name: "@code", value: inviteCode.toUpperCase().trim() }]
            };
            const { resources } = await db.classesContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
            if (!resources.length) return res.status(404).json({ error: "Code invalide ou expiré." });
            const classDoc = resources[0];
            if (classDoc.students.includes(studentEmail)) return res.status(409).json({ error: "Vous êtes déjà dans cette classe." });
            classDoc.students.push(studentEmail);
            await db.classesContainer.items.upsert(classDoc);
            res.json({ className: classDoc.className, classId: classDoc.id });
        } catch (error) {
            res.status(500).json({ error: "Erreur lors de l'adhésion à la classe." });
        }
    });

    router.post('/teacher/classes/reorder', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classOrder } = req.body;
        const teacherEmail = req.user.email;
        try {
            const { resource: teacher } = await db.usersContainer.item(teacherEmail, teacherEmail).read();
            teacher.classOrder = classOrder;
            const { resource: updatedTeacher } = await db.usersContainer.items.upsert(teacher);
            res.status(200).json({ classOrder: updatedTeacher.classOrder });
        } catch (error) { res.status(500).json({ error: "Erreur lors de la mise à jour de l'ordre." }); }
    });

    router.delete('/teacher/classes/:classId/content/:contentId', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId, contentId } = req.params;
        const teacherEmail = req.user.email;
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            classDoc.content = classDoc.content.filter(c => c.id !== contentId);
            classDoc.results = classDoc.results.filter(r => r.contentId !== contentId);
            await db.classesContainer.items.upsert(classDoc);
            res.status(204).send();
        } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
    });

    router.post('/teacher/classes/:classId/remove-student', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId } = req.params;
        const { studentEmail } = req.body;
        const teacherEmail = req.user.email;
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            classDoc.students = classDoc.students.filter(email => email !== studentEmail);
            classDoc.results = classDoc.results.filter(r => r.studentEmail !== studentEmail);
            await db.classesContainer.items.upsert(classDoc);
            res.status(204).send();
        } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
    });

    router.post('/teacher/validate-result', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId, studentEmail, contentId, appreciation, comment } = req.body;
        const teacherEmail = req.user.email;
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            const resultIndex = classDoc.results.findIndex(r => r.studentEmail === studentEmail && r.contentId === contentId);
            if (resultIndex === -1) return res.status(404).json({ error: "Résultat non trouvé." });
            classDoc.results[resultIndex].status = 'validated';
            classDoc.results[resultIndex].appreciation = appreciation;
            classDoc.results[resultIndex].teacherComment = comment;
            classDoc.results[resultIndex].validatedAt = new Date().toISOString();
            await db.classesContainer.items.upsert(classDoc);
            res.status(200).json(classDoc.results[resultIndex]);
            // Notify student (non-blocking)
            const content = (classDoc.content || []).find(c => c.id === contentId);
            pushNotification(db, studentEmail, { type: 'validated', message: `Votre devoir "${content?.title || 'devoir'}" a été corrigé dans "${classDoc.className}".` });
        } catch (error) { res.status(500).json({ error: "Erreur lors de la validation." }); }
    });

    router.get('/teacher/classes/:classId/competency-report', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId } = req.params;
        const teacherEmail = req.user.email;
        try {
            const { resource: classData } = await db.classesContainer.item(classId, teacherEmail).read();
            const validatedQuizzes = (classData.results || []).filter(r => r.status === 'validated' && r.totalQuestions > 0);
            const competencyScores = {};
            validatedQuizzes.forEach(result => {
                const content = (classData.content || []).find(c => c.id === result.contentId);
                if (content && content.competence && content.competence.competence) {
                    const { competence, level } = content.competence;
                    if (!competencyScores[competence]) competencyScores[competence] = { scores: [], total: 0, level };
                    const scorePercentage = (result.score / result.totalQuestions) * 100;
                    competencyScores[competence].scores.push(scorePercentage);
                    competencyScores[competence].total += scorePercentage;
                }
            });
            const report = Object.keys(competencyScores).map(competence => ({
                competence,
                level: competencyScores[competence].level,
                averageScore: Math.round(competencyScores[competence].total / competencyScores[competence].scores.length)
            }));
            res.json(report);
        } catch (error) { res.status(500).json({ error: "Erreur lors de la génération du rapport." }); }
    });

    // --- Student routes ---

    router.get('/student/dashboard', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const studentEmail = req.user.email;
        const querySpec = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: "@studentEmail", value: studentEmail }] };
        try {
            const { resources: studentClasses } = await db.classesContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
            const todo = [], pending = [], completed = [];
            studentClasses.forEach(c => {
                (c.content || []).forEach(content => {
                    const result = (c.results || []).find(r => r.studentEmail === studentEmail && r.contentId === content.id);
                    const item = { ...content, className: c.className, classId: c.id, teacherEmail: c.teacherEmail };
                    if (!result) { todo.push(item); }
                    else {
                        const fullResult = { ...item, ...result };
                        if (result.status === 'pending_validation') pending.push(fullResult);
                        else if (result.status === 'validated') completed.push(fullResult);
                    }
                });
            });
            todo.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
            pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
            completed.sort((a, b) => new Date(b.validatedAt) - new Date(a.validatedAt));
            res.json({ todo, pending, completed });
        } catch (error) {
            console.error("Erreur de récupération du tableau de bord étudiant:", error);
            res.status(500).json({ error: "Erreur de récupération du tableau de bord." });
        }
    });

    // ── MESSAGING ────────────────────────────────────────────────────────────
    async function canMessageEdu(emailA, roleA, emailB, roleB) {
        const teacherEmail = roleA === 'teacher' ? emailA : (roleB === 'teacher' ? emailB : null);
        const studentEmail = roleA === 'student' ? emailA : (roleB === 'student' ? emailB : null);
        if (!teacherEmail || !studentEmail) return false;
        try {
            const { resources } = await db.classesContainer.items.query({
                query: 'SELECT c.students FROM c WHERE c.teacherEmail = @email',
                parameters: [{ name: '@email', value: teacherEmail }]
            }, { enableCrossPartitionQuery: true }).fetchAll();
            return resources.some(c => (c.students || []).includes(studentEmail));
        } catch { return false; }
    }

    router.get('/messages/thread/:otherEmail', async (req, res) => {
        if (!db.eduMessagesContainer) return res.status(503).json({ error: "Service indisponible." });
        const me = req.user;
        const otherEmail = decodeURIComponent(req.params.otherEmail);
        try {
            const { resource: other } = await db.usersContainer.item(otherEmail, otherEmail).read();
            if (!await canMessageEdu(me.email, me.role, otherEmail, other.role))
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

    router.post('/messages/thread/:otherEmail', async (req, res) => {
        if (!db.eduMessagesContainer) return res.status(503).json({ error: "Service indisponible." });
        const me = req.user;
        const otherEmail = decodeURIComponent(req.params.otherEmail);
        const { content } = req.body;
        if (!content?.trim()) return res.status(400).json({ error: "Message vide." });
        try {
            const { resource: other } = await db.usersContainer.item(otherEmail, otherEmail).read();
            if (!await canMessageEdu(me.email, me.role, otherEmail, other.role))
                return res.status(403).json({ error: "Accès refusé." });
            const threadId = [me.email, otherEmail].sort().join(':');
            const msg = {
                id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                threadId, context: 'education',
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

    router.post('/student/submit-quiz', async (req, res) => {
        if (!db.classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { classId, contentId, title, score, totalQuestions, answers, helpUsed, teacherEmail } = req.body;
        const studentEmail = req.user.email;
        const newResult = { studentEmail, contentId, title, score, totalQuestions, answers, helpUsed, submittedAt: new Date().toISOString(), status: 'pending_validation' };
        try {
            const { resource: classDoc } = await db.classesContainer.item(classId, teacherEmail).read();
            classDoc.results = classDoc.results || [];
            classDoc.results.push(newResult);
            await db.classesContainer.items.upsert(classDoc);
            res.status(201).json(newResult);
            // Notify teacher (non-blocking)
            pushNotification(db, teacherEmail, { type: 'new_submission', message: `${studentEmail} a rendu "${title || 'un devoir'}" dans "${classDoc.className}".` });
        } catch (error) { res.status(500).json({ error: "Erreur lors de la soumission." }); }
    });

    return router;
};
