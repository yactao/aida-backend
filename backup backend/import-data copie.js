const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs').promises;
require('dotenv').config();

// --- Configuration ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

const usersFilePath = './users.json';
const classesFilePath = './classes.json';
const completedContentFilePath = './completed-content.json';

// --- Script ---
async function main() {
    console.log("--- Lancement du script d'importation AIDA ---");

    if (!endpoint || !key) {
        console.error("ERREUR : Les variables COSMOS_ENDPOINT et COSMOS_KEY doivent être définies dans le fichier .env");
        return;
    }

    const client = new CosmosClient({ endpoint, key });

    try {
        // ÉTAPE 1: Créer la base de données AVEC UN BUDGET PARTAGÉ
        console.log(`\nCréation/vérification de la base de données '${databaseId}' avec budget partagé...`);
        // On définit le "budget" de performance au niveau de la base de données
        const { database } = await client.databases.createIfNotExists({ id: databaseId, throughput: 400 });
        
        console.log(`Création/vérification du conteneur '${usersContainerId}'...`);
        // Les conteneurs vont maintenant utiliser le budget partagé
        await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
        
        console.log(`Création/vérification du conteneur '${classesContainerId}'...`);
        await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });

        console.log(`Création/vérification du conteneur '${completedContentContainerId}'...`);
        await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });

        console.log("✅ Base de données et conteneurs prêts.");

        // ÉTAPE 2: Connexion aux conteneurs
        const usersContainer = database.container(usersContainerId);
        const classesContainer = database.container(classesContainerId);
        const completedContentContainer = database.container(completedContentContainerId);

        // ÉTAPE 3: Importer les données
        const usersData = JSON.parse(await fs.readFile(usersFilePath, 'utf-8'));
        console.log(`\nImportation de ${usersData.length} utilisateurs...`);
        for (const user of usersData) {
            await usersContainer.items.upsert(user);
        }
        console.log("✅ Importation des utilisateurs terminée.");

        const classesData = JSON.parse(await fs.readFile(classesFilePath, 'utf-8'));
        console.log(`\nImportation de ${classesData.length} classes...`);
        for (const classItem of classesData) {
            await classesContainer.items.upsert(classItem);
        }
        console.log("✅ Importation des classes terminée.");

        const completedData = JSON.parse(await fs.readFile(completedContentFilePath, 'utf-8'));
        console.log(`\nImportation de ${completedData.length} entrées de contenu terminé...`);
        for (const item of completedData) {
            await completedContentContainer.items.upsert(item);
        }
        console.log("✅ Importation du contenu terminé.");

    } catch (error) {
        console.error("\n--- Une erreur est survenue ---");
        console.error(error);
    } finally {
        console.log("\n--- Script terminé ---");
    }
}

main();

