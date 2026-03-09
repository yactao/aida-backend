const express = require('express');

const AVAILABLE_AVATARS = [
    'adam.png','alice.png','arthur.png','chloe.png','emma.png','gabi.png',
    'hanenne.png','hugo.png','imrane.png','isa.png','jade.png','joe.png',
    'jules.png','karim.png','lea.png','louis.png','louise.png','manon.png',
    'mohamed.png','nathalie dubois.png','raph.png','rose.png','salma.png',
    'sheima.png','sohane.png','tao.png'
];

module.exports = function ({ db, bcrypt }) {
    const router = express.Router();

    router.patch('/user/profile', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { firstName, avatar } = req.body;
        const email = req.user.email;
        if (!firstName || firstName.trim().length < 1) return res.status(400).json({ error: "Le prénom est requis." });
        if (avatar && !AVAILABLE_AVATARS.includes(avatar)) return res.status(400).json({ error: "Avatar invalide." });
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            user.firstName = firstName.trim();
            if (avatar) user.avatar = avatar;
            await db.usersContainer.items.upsert(user);
            delete user.password;
            res.json(user);
        } catch (e) {
            res.status(500).json({ error: "Erreur lors de la mise à jour du profil." });
        }
    });

    router.post('/user/change-password', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { currentPassword, newPassword } = req.body;
        const email = req.user.email;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: "Les deux mots de passe sont requis." });
        if (newPassword.length < 6) return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            if (!user.password) return res.status(400).json({ error: "Compte Google — aucun mot de passe défini." });
            const match = await bcrypt.compare(currentPassword, user.password);
            if (!match) return res.status(401).json({ error: "Mot de passe actuel incorrect." });
            user.password = await bcrypt.hash(newPassword, 10);
            await db.usersContainer.items.upsert(user);
            res.json({ message: "Mot de passe modifié avec succès." });
        } catch (e) {
            res.status(500).json({ error: "Erreur lors du changement de mot de passe." });
        }
    });

    return router;
};
