// jobs/streakReminder.js
// Tournant toutes les 24h — envoie un email de rappel aux élèves Academy
// dont le streak est actif mais qui ne se sont pas encore connectés aujourd'hui.

const nodemailer = require('nodemailer');

function createMailTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
}

async function sendStreakReminders(db) {
    if (!db.usersContainer) return;
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        console.log('[StreakJob] SMTP non configuré — envoi ignoré.');
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    try {
        const { resources: students } = await db.usersContainer.items.query(
            {
                query: "SELECT c.id, c.email, c.firstName, c.dailyStreak FROM c WHERE c.role = 'academy_student'"
            },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        const transporter = createMailTransporter();
        let sent = 0;

        for (const student of students) {
            const streak = student.dailyStreak;
            if (!streak || streak.count < 1) continue;               // Pas de streak actif
            if (streak.lastLogin === today) continue;                 // Déjà connecté aujourd'hui
            if (streak.lastLogin !== yesterday) continue;             // Streak déjà cassé

            // lastLogin = hier → streak va expirer si l'élève ne se connecte pas aujourd'hui
            try {
                await transporter.sendMail({
                    from: `"AÏDA Academy" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
                    to: student.email,
                    subject: `🔥 Ta série de ${streak.count} jour${streak.count > 1 ? 's' : ''} est en danger !`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
                            <h2 style="color: #ef4444;">🔥 Ne perds pas ta série !</h2>
                            <p>Bonjour <strong>${student.firstName}</strong>,</p>
                            <p>
                                Tu as une série de <strong>${streak.count} jour${streak.count > 1 ? 's' : ''} consécutifs</strong>
                                sur l'Académie AÏDA. Si tu ne te connectes pas aujourd'hui, tu perdras tout !
                            </p>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${process.env.APP_URL || 'https://gray-meadow-0061b3603.1.azurestaticapps.net'}"
                                   style="background:#3b82f6;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
                                    Continuer ma série →
                                </a>
                            </div>
                            <p style="color: #6b7280; font-size: 0.85em;">
                                Continuez à apprendre l'Arabe Littéraire chaque jour pour débloquer de nouveaux badges !
                            </p>
                        </div>
                    `
                });
                sent++;
                console.log(`[StreakJob] Email envoyé à ${student.email} (série: ${streak.count}j)`);
            } catch (emailErr) {
                console.error(`[StreakJob] Erreur email pour ${student.email}:`, emailErr.message);
            }
        }

        console.log(`[StreakJob] ${sent} email(s) de rappel envoyé(s) sur ${students.length} élèves.`);
    } catch (err) {
        console.error('[StreakJob] Erreur lors de la requête:', err.message);
    }
}

/**
 * Démarre le job de rappel streak.
 * @param {object} db - L'objet db partagé avec les containers Cosmos.
 */
function startStreakReminderJob(db) {
    const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

    // Premier run : 5 minutes après le démarrage du serveur
    setTimeout(() => {
        sendStreakReminders(db);
        setInterval(() => sendStreakReminders(db), INTERVAL_MS);
    }, 5 * 60 * 1000);

    console.log('[StreakJob] Job de rappel streak planifié (toutes les 24h).');
}

module.exports = { startStreakReminderJob };
