const express = require('express');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

function createMailTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

module.exports = function ({ db, bcrypt, jwt, jwtSecret }) {
    const router = express.Router();

    // --- AIDA Education login ---
    router.post('/auth/login', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email, password } = req.body;
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            const passwordMatch = user && !user.role.startsWith('academy_') && await bcrypt.compare(password, user.password);
            if (passwordMatch) {
                delete user.password;
                const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '7d' });
                res.json({ user, token });
            } else {
                res.status(401).json({ error: "Email ou mot de passe incorrect." });
            }
        } catch (error) {
            if (error.code === 404) {
                res.status(401).json({ error: "Email ou mot de passe incorrect." });
            } else {
                res.status(500).json({ error: "Erreur du serveur." });
            }
        }
    });

    // --- AIDA Education signup ---
    router.post('/auth/signup', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email, password, role } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) return res.status(400).json({ error: "Email invalide." });
        if (!password || password.length < 6) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
        if (!['student', 'teacher'].includes(role)) return res.status(400).json({ error: "Rôle invalide." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = { id: email, email, password: hashedPassword, role, firstName: email.split('@')[0], avatar: 'default.png', classOrder: [] };
        try {
            const { resource: createdUser } = await db.usersContainer.items.create(newUser);
            delete createdUser.password;
            const token = jwt.sign({ email: createdUser.email, role: createdUser.role }, jwtSecret, { expiresIn: '7d' });
            res.status(201).json({ user: createdUser, token });
        } catch (error) {
            if (error.code === 409) {
                res.status(409).json({ error: "Cet email est déjà utilisé." });
            } else {
                res.status(500).json({ error: "Erreur lors de la création du compte." });
            }
        }
    });

    // --- Academy login (with streak logic) ---
    router.post('/academy/auth/login', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email, password } = req.body;
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            const isAcademyRole = user?.role?.startsWith('academy_');
            const academyPasswordMatch = user && isAcademyRole && await bcrypt.compare(password, user.password);
            if (academyPasswordMatch) {
                if (user.role === 'academy_student') {
                    const today = new Date().toISOString().split('T')[0];
                    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                    let streak = user.dailyStreak || { count: 0, lastLogin: null };
                    user.achievements = user.achievements || [];
                    if (streak.lastLogin === yesterday) {
                        streak.count++;
                        streak.lastLogin = today;
                    } else if (streak.lastLogin !== today) {
                        streak.count = 1;
                        streak.lastLogin = today;
                    }
                    user.dailyStreak = streak;
                    if (streak.count >= 3 && !user.achievements.includes('streak_3')) {
                        user.achievements.push('streak_3');
                    }
                    await db.usersContainer.item(user.id, user.id).replace(user);
                }
                delete user.password;
                const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '7d' });
                res.json({ user, token });
            } else {
                res.status(401).json({ error: "Email, mot de passe ou rôle incorrect pour l'Académie." });
            }
        } catch (error) {
            if (error.code === 404) {
                res.status(401).json({ error: "Email, mot de passe ou rôle incorrect pour l'Académie." });
            } else {
                console.error("Erreur de connexion Académie:", error);
                res.status(500).json({ error: "Erreur du serveur." });
            }
        }
    });

    // --- Academy signup ---
    router.post('/academy/auth/signup', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email, password, role } = req.body;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !emailRegex.test(email)) return res.status(400).json({ error: "Email invalide." });
        if (!password || password.length < 6) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
        if (!['academy_student', 'academy_teacher', 'academy_parent'].includes(role)) return res.status(400).json({ error: "Rôle invalide pour l'Académie." });
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = { id: email, email, password: hashedPassword, role, firstName: email.split('@')[0], avatar: 'default.png' };
        try {
            const { resource: createdUser } = await db.usersContainer.items.create(newUser);
            delete createdUser.password;
            const token = jwt.sign({ email: createdUser.email, role: createdUser.role }, jwtSecret, { expiresIn: '7d' });
            res.status(201).json({ user: createdUser, token });
        } catch (error) {
            if (error.code === 409) {
                res.status(409).json({ error: "Cet email est déjà utilisé." });
            } else {
                res.status(500).json({ error: "Erreur lors de la création du compte." });
            }
        }
    });

    // --- Helper: find or create user (Google OAuth) ---
    async function findOrCreateGoogleUser(email, name, role, authProvider) {
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            return user;
        } catch (e) {
            if (e.code !== 404) throw e;
            const newUser = {
                id: email, email, role,
                firstName: name?.split(' ')[0] || email.split('@')[0],
                avatar: 'default.png',
                classOrder: [],
                authProvider
            };
            const { resource: created } = await db.usersContainer.items.create(newUser);
            return created;
        }
    }

    // --- Google Sign-In (AÏDA Éducation) ---
    router.post('/auth/google', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { idToken, role } = req.body;
        if (!idToken) return res.status(400).json({ error: "Token Google manquant." });
        try {
            const { data } = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
            if (process.env.GOOGLE_CLIENT_ID && data.aud !== process.env.GOOGLE_CLIENT_ID) {
                return res.status(401).json({ error: "Token Google invalide." });
            }
            const { email, name } = data;
            if (!email) return res.status(400).json({ error: "Impossible de récupérer l'email Google." });
            const user = await findOrCreateGoogleUser(email, name, role || 'student', 'google');
            delete user.password;
            const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '7d' });
            res.json({ user, token });
        } catch (error) {
            console.error("Erreur Google Auth:", error.response?.data || error.message);
            res.status(500).json({ error: "Erreur lors de l'authentification Google." });
        }
    });

    // --- Google Sign-In (Académie MRE) ---
    router.post('/academy/auth/google', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { idToken, role } = req.body;
        if (!idToken) return res.status(400).json({ error: "Token Google manquant." });
        if (!['academy_student', 'academy_teacher', 'academy_parent'].includes(role)) {
            return res.status(400).json({ error: "Rôle invalide pour l'Académie." });
        }
        try {
            const { data } = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
            if (process.env.GOOGLE_CLIENT_ID && data.aud !== process.env.GOOGLE_CLIENT_ID) {
                return res.status(401).json({ error: "Token Google invalide." });
            }
            const { email, name } = data;
            if (!email) return res.status(400).json({ error: "Impossible de récupérer l'email Google." });
            const user = await findOrCreateGoogleUser(email, name, role, 'google');
            delete user.password;
            const token = jwt.sign({ email: user.email, role: user.role }, jwtSecret, { expiresIn: '7d' });
            res.json({ user, token });
        } catch (error) {
            console.error("Erreur Google Auth Académie:", error.response?.data || error.message);
            res.status(500).json({ error: "Erreur lors de l'authentification Google." });
        }
    });

    // --- Mot de passe oublié ---
    router.post('/auth/forgot-password', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email requis." });

        // Always return 200 to avoid user enumeration
        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            if (!user || user.authProvider === 'google') {
                return res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
            }
            const token = crypto.randomBytes(32).toString('hex');
            const expiry = new Date(Date.now() + 3600000).toISOString(); // 1h
            user.resetToken = token;
            user.resetTokenExpiry = expiry;
            await db.usersContainer.item(user.id, user.id).replace(user);

            const appUrl = process.env.APP_URL || 'https://gray-meadow-0061b3603.1.azurestaticapps.net';
            const resetLink = `${appUrl}?action=reset-password&token=${token}&email=${encodeURIComponent(email)}`;

            const transporter = createMailTransporter();
            await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to: email,
                subject: 'Réinitialisation de votre mot de passe AÏDA',
                html: `
                    <div style="font-family:sans-serif;max-width:500px;margin:auto;">
                        <h2 style="color:#6366F1;">AÏDA Éducation</h2>
                        <p>Bonjour,</p>
                        <p>Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous :</p>
                        <a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#6366F1;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Réinitialiser mon mot de passe</a>
                        <p style="color:#888;font-size:12px;margin-top:24px;">Ce lien expire dans 1 heure. Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>
                    </div>`
            });
        } catch (e) {
            if (e.code !== 404) {
                console.error("Erreur forgot-password:", e.message);
            }
        }
        res.json({ message: "Si cet email existe, un lien de réinitialisation a été envoyé." });
    });

    // --- Réinitialisation du mot de passe ---
    router.post('/auth/reset-password', async (req, res) => {
        if (!db.usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
        const { email, token, newPassword } = req.body;
        if (!email || !token || !newPassword) return res.status(400).json({ error: "Données manquantes." });
        if (newPassword.length < 6) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });

        try {
            const { resource: user } = await db.usersContainer.item(email, email).read();
            if (!user || user.resetToken !== token) {
                return res.status(400).json({ error: "Lien invalide ou expiré." });
            }
            if (!user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date()) {
                return res.status(400).json({ error: "Ce lien a expiré. Veuillez faire une nouvelle demande." });
            }
            user.password = await bcrypt.hash(newPassword, 10);
            delete user.resetToken;
            delete user.resetTokenExpiry;
            await db.usersContainer.item(user.id, user.id).replace(user);
            res.json({ message: "Mot de passe réinitialisé avec succès." });
        } catch (e) {
            if (e.code === 404) return res.status(400).json({ error: "Lien invalide ou expiré." });
            console.error("Erreur reset-password:", e.message);
            res.status(500).json({ error: "Erreur du serveur." });
        }
    });

    return router;
};
