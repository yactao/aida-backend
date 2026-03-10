// routes/production.js
// Pipeline de production d'épisodes : génération script IA → gestion URL Vimeo → déploiement

const express = require('express');
const axios = require('axios');

async function generateEpisodeScript(episodeData) {
    const { title, narratorIntro, vocabulary, objectives } = episodeData;
    if (!process.env.DEEPSEEK_API_KEY) throw new Error("Clé API Deepseek non configurée.");

    const vocabList = (vocabulary || []).join('\n- ');
    const objList = (objectives || []).join('\n- ');

    const prompt = `Tu es scénariste pour une série animée éducative en arabe pour enfants de 7-12 ans intitulée "Zayd et Yasmina : Les Gardiens de l'Astrolabe".

Génère un script vidéo complet pour cet épisode. Le script sera utilisé sur Magiclight.ai pour générer la vidéo animée.

ÉPISODE : ${title}
INTRODUCTION DU NARRATEUR (Fahim) : "${narratorIntro || ''}"
VOCABULAIRE À INTÉGRER :
- ${vocabList || '(vocabulaire général)'}
OBJECTIFS PÉDAGOGIQUES :
- ${objList || '(objectifs généraux)'}

CONSIGNES DU SCRIPT :
1. Durée cible : 3 à 4 minutes
2. Structure : [NARRATEUR] → [SCÈNE PRINCIPALE] → [MOT DE POUVOIR] → [CLIFFHANGER]
3. Tags à utiliser : [NARRATEUR], [ZAYD], [YASMINA], [DESCRIPTION VISUELLE], [MOT DE POUVOIR]
4. Quand les personnages parlent arabe, ajouter la phonétique entre parenthèses
5. Les descriptions visuelles doivent être précises pour Magiclight.ai : décor, éclairage, action
6. Intégrer naturellement le vocabulaire de l'épisode dans les dialogues
7. Terminer sur un cliffhanger ou une révélation pour l'épisode suivant

Génère le script complet, prêt à copier-coller dans Magiclight.ai.`;

    const response = await axios.post(
        `${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/v1/chat/completions`,
        {
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [{ role: 'user', content: prompt }]
        },
        { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } }
    );

    return response.data.choices[0].message.content;
}

module.exports = function ({ db }) {
    const router = express.Router();

    // --- Route publique (pour le player élève) ---
    // GET /api/production/episode/:episodeId — données d'un épisode (URL Vimeo si publié)
    router.get('/production/episode/:episodeId', async (req, res) => {
        const { episodeId } = req.params;
        if (!db.episodesContainer) return res.json({ id: episodeId, status: 'pending' });
        try {
            const { resources } = await db.episodesContainer.items.query(
                { query: 'SELECT c.id, c.status, c.vimeoUrl, c.publishedAt FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                { partitionKey: episodeId }
            ).fetchAll();
            res.json(resources[0] || { id: episodeId, status: 'pending' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- Routes enseignant uniquement ---

    // GET /api/production/episodes — liste tous les épisodes avec leur statut
    router.get('/production/episodes', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        if (!db.episodesContainer) return res.json([]);
        try {
            const { resources } = await db.episodesContainer.items.query(
                'SELECT c.id, c.title, c.status, c.vimeoUrl, c.scriptGeneratedAt, c.publishedAt FROM c',
                { enableCrossPartitionQuery: true }
            ).fetchAll();
            res.json(resources);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET /api/production/episode-full/:episodeId — détail complet (script inclus)
    router.get('/production/episode-full/:episodeId', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        const { episodeId } = req.params;
        if (!db.episodesContainer) return res.json({ id: episodeId, status: 'pending' });
        try {
            const { resources } = await db.episodesContainer.items.query(
                { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                { partitionKey: episodeId }
            ).fetchAll();
            res.json(resources[0] || { id: episodeId, status: 'pending' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/production/generate-script — génère un script via IA
    router.post('/production/generate-script', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        const { episodeId, title, narratorIntro, vocabulary, objectives } = req.body;
        if (!episodeId || !title) return res.status(400).json({ error: 'episodeId et title requis.' });

        try {
            const script = await generateEpisodeScript({ title, narratorIntro, vocabulary, objectives });

            if (db.episodesContainer) {
                const { resources } = await db.episodesContainer.items.query(
                    { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                    { partitionKey: episodeId }
                ).fetchAll();
                const doc = resources[0] || { id: episodeId };
                doc.title = title;
                doc.script = script;
                doc.status = doc.status === 'published' ? 'published' : 'script_ready';
                doc.scriptGeneratedAt = new Date().toISOString();
                await db.episodesContainer.items.upsert(doc);
            }

            res.json({ episodeId, script });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // PATCH /api/production/episode/:episodeId — met à jour l'URL Vimeo et/ou les notes
    router.patch('/production/episode/:episodeId', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        const { episodeId } = req.params;
        const { vimeoUrl, notes } = req.body;

        if (!db.episodesContainer) return res.status(503).json({ error: 'DB indisponible.' });

        try {
            const { resources } = await db.episodesContainer.items.query(
                { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                { partitionKey: episodeId }
            ).fetchAll();
            const doc = resources[0] || { id: episodeId };
            if (vimeoUrl !== undefined) {
                doc.vimeoUrl = vimeoUrl;
                if (doc.status === 'pending' || doc.status === 'script_ready') doc.status = 'video_ready';
            }
            if (notes !== undefined) doc.notes = notes;
            await db.episodesContainer.items.upsert(doc);
            res.json({ episodeId, status: doc.status, vimeoUrl: doc.vimeoUrl });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/production/publish/:episodeId — publie l'épisode (visible pour les élèves)
    router.post('/production/publish/:episodeId', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        const { episodeId } = req.params;

        if (!db.episodesContainer) return res.status(503).json({ error: 'DB indisponible.' });

        try {
            const { resources } = await db.episodesContainer.items.query(
                { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                { partitionKey: episodeId }
            ).fetchAll();
            const doc = resources[0];
            if (!doc) return res.status(404).json({ error: 'Épisode non trouvé en base.' });
            if (!doc.vimeoUrl) return res.status(400).json({ error: 'Ajoutez d\'abord une URL Vimeo avant de publier.' });

            doc.status = 'published';
            doc.publishedAt = new Date().toISOString();
            await db.episodesContainer.items.upsert(doc);

            res.json({ episodeId, status: 'published', vimeoUrl: doc.vimeoUrl, publishedAt: doc.publishedAt });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/production/unpublish/:episodeId — dépublie (remet en video_ready)
    router.post('/production/unpublish/:episodeId', async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Réservé aux enseignants.' });
        const { episodeId } = req.params;

        if (!db.episodesContainer) return res.status(503).json({ error: 'DB indisponible.' });

        try {
            const { resources } = await db.episodesContainer.items.query(
                { query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: episodeId }] },
                { partitionKey: episodeId }
            ).fetchAll();
            const doc = resources[0];
            if (!doc) return res.status(404).json({ error: 'Épisode non trouvé.' });
            doc.status = 'video_ready';
            delete doc.publishedAt;
            await db.episodesContainer.items.upsert(doc);
            res.json({ episodeId, status: 'video_ready' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
