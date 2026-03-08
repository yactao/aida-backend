const express = require('express');

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
        } catch (error) { res.status(500).json({ error: "Erreur lors de l'assignation." }); }
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
        } catch (error) { res.status(500).json({ error: "Erreur lors de la soumission." }); }
    });

    return router;
};
