// routes/srs.js
// Système de Répétition Espacée (algorithme SM-2 simplifié)
// quality : 0 = oublié, 1 = difficile, 2 = facile

const express = require('express');

function sm2Update(card, quality) {
    let { interval = 1, repetitions = 0, easeFactor = 2.5 } = card;

    if (quality === 0) {
        // Oublié → reset
        interval = 1;
        repetitions = 0;
    } else {
        // Mémorisé
        if (repetitions === 0)      interval = 1;
        else if (repetitions === 1) interval = 3;
        else                        interval = Math.round(interval * easeFactor);

        repetitions++;

        if (quality === 1) {
            // Difficile → réduire l'intervalle et la facilité
            easeFactor = Math.max(1.3, easeFactor - 0.15);
            interval    = Math.max(1, Math.round(interval * 0.8));
        } else {
            // Facile → augmenter la facilité
            easeFactor = Math.min(2.5, easeFactor + 0.1);
        }
    }

    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + interval);

    return {
        interval,
        repetitions,
        easeFactor,
        nextReviewDate: nextDate.toISOString().split('T')[0],
        lastReviewDate: new Date().toISOString().split('T')[0]
    };
}

module.exports = function ({ db }) {
    const router = express.Router();

    // POST /api/srs/initialize — crée les cartes manquantes pour un utilisateur
    router.post('/srs/initialize', async (req, res) => {
        if (!db.srsContainer) return res.status(503).json({ error: 'Service indisponible.' });
        const userId = req.user.email;
        const { cards } = req.body;
        if (!Array.isArray(cards) || cards.length === 0) return res.status(400).json({ error: 'cards[] requis.' });

        try {
            const { resources: existing } = await db.srsContainer.items.query(
                { query: 'SELECT c.id FROM c WHERE c.userId = @userId', parameters: [{ name: '@userId', value: userId }] },
                { partitionKey: userId }
            ).fetchAll();

            const existingIds = new Set(existing.map(c => c.id));
            const today = new Date().toISOString().split('T')[0];
            let created = 0;

            for (const card of cards) {
                const id = `${userId}|${card.key}`;
                if (existingIds.has(id)) continue;
                await db.srsContainer.items.create({
                    id,
                    userId,
                    key: card.key,
                    episodeId: card.episodeId,
                    cardType: card.type,
                    arabe: card.arabe,
                    phonetique: card.phonetique,
                    francais: card.francais,
                    interval: 1,
                    repetitions: 0,
                    easeFactor: 2.5,
                    nextReviewDate: today,
                    lastReviewDate: null
                });
                created++;
            }

            res.json({ created, total: existingIds.size + created });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/srs/due — cartes à réviser aujourd'hui (max 20 nouvelles, illimité révisions)
    router.get('/srs/due', async (req, res) => {
        if (!db.srsContainer) return res.status(503).json({ error: 'Service indisponible.' });
        const userId = req.user.email;
        const today = new Date().toISOString().split('T')[0];

        try {
            const { resources } = await db.srsContainer.items.query(
                {
                    query: 'SELECT * FROM c WHERE c.userId = @userId AND c.nextReviewDate <= @today ORDER BY c.repetitions ASC, c.nextReviewDate ASC',
                    parameters: [{ name: '@userId', value: userId }, { name: '@today', value: today }]
                },
                { partitionKey: userId }
            ).fetchAll();

            // Limiter les nouvelles cartes (jamais vues) à 20 par session
            const newCards     = resources.filter(c => c.repetitions === 0).slice(0, 20);
            const reviewCards  = resources.filter(c => c.repetitions > 0);
            const due = [...reviewCards, ...newCards];

            res.json(due);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/srs/stats — statistiques globales
    router.get('/srs/stats', async (req, res) => {
        if (!db.srsContainer) return res.status(503).json({ error: 'Service indisponible.' });
        const userId = req.user.email;
        const today = new Date().toISOString().split('T')[0];

        try {
            const { resources } = await db.srsContainer.items.query(
                {
                    query: 'SELECT c.nextReviewDate, c.repetitions, c.interval FROM c WHERE c.userId = @userId',
                    parameters: [{ name: '@userId', value: userId }]
                },
                { partitionKey: userId }
            ).fetchAll();

            const total    = resources.length;
            const due      = resources.filter(c => c.nextReviewDate <= today).length;
            const mastered = resources.filter(c => c.interval >= 21).length;

            res.json({ total, due, mastered });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/srs/review — soumettre une réponse (quality 0/1/2)
    router.post('/srs/review', async (req, res) => {
        if (!db.srsContainer) return res.status(503).json({ error: 'Service indisponible.' });
        const userId = req.user.email;
        const { cardId, quality } = req.body;
        if (!cardId || quality === undefined) return res.status(400).json({ error: 'cardId et quality requis.' });

        try {
            const { resources } = await db.srsContainer.items.query(
                {
                    query: 'SELECT * FROM c WHERE c.id = @id AND c.userId = @userId',
                    parameters: [{ name: '@id', value: cardId }, { name: '@userId', value: userId }]
                },
                { partitionKey: userId }
            ).fetchAll();

            if (resources.length === 0) return res.status(404).json({ error: 'Carte non trouvée.' });

            const card = resources[0];
            Object.assign(card, sm2Update(card, quality));
            await db.srsContainer.items.upsert(card);

            res.json({ cardId, nextReviewDate: card.nextReviewDate, interval: card.interval });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
