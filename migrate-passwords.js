/**
 * Script de migration : hachage des mots de passe existants avec bcrypt
 * Usage : node migrate-passwords.js
 * A executer UNE SEULE FOIS puis supprimer.
 */
require('dotenv').config();
const { CosmosClient } = require('@azure/cosmos');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

async function migratePasswords() {
    const dbClient = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    const container = dbClient.database('AidaDB').container('Users');

    const { resources: users } = await container.items.readAll().fetchAll();
    console.log(`${users.length} utilisateurs trouvés.`);

    let migrated = 0;
    let skipped = 0;

    for (const user of users) {
        // Si le mot de passe commence par $2b$, il est déjà haché
        if (user.password && user.password.startsWith('$2b$')) {
            console.log(`  [SKIP] ${user.email} — déjà haché`);
            skipped++;
            continue;
        }
        if (!user.password) {
            console.log(`  [SKIP] ${user.email} — pas de mot de passe`);
            skipped++;
            continue;
        }

        const hashed = await bcrypt.hash(user.password, SALT_ROUNDS);
        user.password = hashed;
        await container.item(user.id, user.id).replace(user);
        console.log(`  [OK]   ${user.email} — mot de passe haché`);
        migrated++;
    }

    console.log(`\nMigration terminée : ${migrated} hachés, ${skipped} ignorés.`);
}

migratePasswords().catch(err => {
    console.error('Erreur migration :', err.message);
    process.exit(1);
});
