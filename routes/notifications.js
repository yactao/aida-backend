const express = require('express');

module.exports = function ({ db }) {
    const router = express.Router();

    router.get('/notifications', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        try {
            const { resource: user } = await db.usersContainer.item(req.user.email, req.user.email).read();
            res.json(user.notifications || []);
        } catch (e) {
            if (e.code === 404) return res.json([]);
            res.status(500).json({ error: "Erreur lors de la récupération des notifications." });
        }
    });

    router.post('/notifications/mark-read', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        try {
            const { resource: user } = await db.usersContainer.item(req.user.email, req.user.email).read();
            (user.notifications || []).forEach(n => { n.read = true; });
            await db.usersContainer.items.upsert(user);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: "Erreur." });
        }
    });

    return router;
};
