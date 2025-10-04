const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs').promises;
require('dotenv').config();

// --- Configuration ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';

const usersFilePath = './users.json';
const classesFilePath = './classes.json';

// --- Script ---
async function main() {
    console.log("--- Lancement du script d'importation AIDA ---");

    if (!endpoint || !key) {
        console.error("ERREUR : Les variables COSMOS_ENDPOINT et COSMOS_KEY doivent être définies dans le fichier .env");
        return;
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const usersContainer = database.container(usersContainerId);
    const classesContainer = database.container(classesContainerId);

    console.log("Connexion à la base de données réussie.");

    try {
        // Importer les utilisateurs
        const usersData = JSON.parse(await fs.readFile(usersFilePath, 'utf-8'));
        console.log(`\nImportation de ${usersData.length} utilisateurs...`);
        for (const user of usersData) {
            await usersContainer.items.upsert(user);
            console.log(`- Utilisateur '${user.email}' importé/mis à jour.`);
        }
        console.log("✅ Importation des utilisateurs terminée.");

        // Importer les classes
        const classesData = JSON.parse(await fs.readFile(classesFilePath, 'utf-8'));
        console.log(`\nImportation de ${classesData.length} classes...`);
        for (const classItem of classesData) {
            // Créer un ID unique si non fourni
            if (!classItem.id) {
                classItem.id = `${classItem.className.replace(/\s+/g, '-')}-${Date.now()}`;
            }
            await classesContainer.items.upsert(classItem);
            console.log(`- Classe '${classItem.className}' importée/mise à jour.`);
        }
        console.log("✅ Importation des classes terminée.");

    } catch (error) {
        console.error("\n--- Une erreur est survenue ---");
        console.error(error);
    } finally {
        console.log("\n--- Script terminé ---");
    }
}

main();
