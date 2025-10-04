// --- 1. Importer les outils nécessaires ---
const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs').promises;
require('dotenv').config();

// --- 2. Configuration ---
// Assurez-vous que votre fichier .env contient bien ces clés
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

// Noms des fichiers de sauvegarde
const usersBackupPath = './users-backup.json';
const classesBackupPath = './classes-backup.json';
const completedContentBackupPath = './completed-content-backup.json';

// --- 3. Le script de sauvegarde ---
async function backupDatabase() {
    console.log("--- Lancement du script de sauvegarde AIDA ---");

    if (!endpoint || !key) {
        console.error("ERREUR : Les variables COSMOS_ENDPOINT et COSMOS_KEY sont manquantes dans votre fichier .env");
        return;
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    console.log("Connecté à la base de données AidaDB.");

    try {
        // Sauvegarder les utilisateurs
        console.log(`\nLecture du conteneur '${usersContainerId}'...`);
        const usersContainer = database.container(usersContainerId);
        const { resources: users } = await usersContainer.items.readAll().fetchAll();
        await fs.writeFile(usersBackupPath, JSON.stringify(users, null, 2));
        console.log(`✅ ${users.length} utilisateurs sauvegardés dans le fichier : ${usersBackupPath}`);

        // Sauvegarder les classes
        console.log(`\nLecture du conteneur '${classesContainerId}'...`);
        const classesContainer = database.container(classesContainerId);
        const { resources: classes } = await classesContainer.items.readAll().fetchAll();
        await fs.writeFile(classesBackupPath, JSON.stringify(classes, null, 2));
        console.log(`✅ ${classes.length} classes sauvegardées dans le fichier : ${classesBackupPath}`);

        // Sauvegarder le contenu complété
        console.log(`\nLecture du conteneur '${completedContentContainerId}'...`);
        const completedContentContainer = database.container(completedContentContainerId);
        const { resources: completedContent } = await completedContentContainer.items.readAll().fetchAll();
        await fs.writeFile(completedContentBackupPath, JSON.stringify(completedContent, null, 2));
        console.log(`✅ ${completedContent.length} entrées de contenu complété sauvegardées dans : ${completedContentBackupPath}`);

    } catch (error) {
        console.error("\n--- Une erreur est survenue pendant la sauvegarde ---");
        if (error.code === 'ERR_NOT_FOUND') {
            console.error(`Erreur : Un des conteneurs n'a pas été trouvé. Avez-vous déjà supprimé la base de données ?`);
        } else {
            console.error(error);
        }
    } finally {
        console.log("\n--- Script de sauvegarde terminé ---");
    }
}

backupDatabase();
