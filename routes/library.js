const express = require('express');

module.exports = function ({ db }) {
    const router = express.Router();

    router.get('/library', async (req, res) => {
        if (!db.libraryContainer) return res.status(503).json({ error: "Service de bibliothèque indisponible." });
        const { searchTerm, subject } = req.query;
        let query = "SELECT * FROM c";
        const parameters = [];
        const conditions = [];
        if (subject) { conditions.push("c.subject = @subject"); parameters.push({ name: "@subject", value: subject }); }
        if (searchTerm) { conditions.push("CONTAINS(c.title, @searchTerm, true)"); parameters.push({ name: "@searchTerm", value: searchTerm }); }
        if (conditions.length > 0) query += " WHERE " + conditions.join(" AND ");
        query += " ORDER BY c.publishedAt DESC";
        try {
            const options = { enableCrossPartitionQuery: !subject };
            const { resources: items } = await db.libraryContainer.items.query({ query, parameters }, options).fetchAll();
            res.json(items);
        } catch (error) {
            console.error("Erreur de recherche dans la bibliothèque:", error);
            res.status(500).json({ error: "Impossible de récupérer la bibliothèque." });
        }
    });

    router.post('/library/publish', async (req, res) => {
        if (!db.libraryContainer) return res.status(503).json({ error: "Service de bibliothèque indisponible." });
        const { contentData, teacherName, subject } = req.body;
        if (!contentData || !teacherName || !subject) return res.status(400).json({ error: "Données de publication incomplètes." });
        const newLibraryItem = {
            ...contentData,
            id: `lib-${contentData.id || Date.now()}`,
            originalContentId: contentData.id,
            authorName: teacherName,
            publishedAt: new Date().toISOString(),
            subject
        };
        delete newLibraryItem.assignedAt;
        delete newLibraryItem.dueDate;
        delete newLibraryItem.isEvaluated;
        delete newLibraryItem.classId;
        delete newLibraryItem.teacherEmail;
        try {
            const { resource: publishedItem } = await db.libraryContainer.items.create(newLibraryItem);
            res.status(201).json(publishedItem);
        } catch (error) {
            if (error.code === 409) {
                res.status(409).json({ error: "Ce contenu existe déjà dans la bibliothèque." });
            } else {
                console.error("Erreur de publication dans la bibliothèque:", error);
                res.status(500).json({ error: "Erreur lors de la publication." });
            }
        }
    });

    return router;
};
