const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs').promises;
require('dotenv').config();

// Configuration
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

const usersFilePath = './users.json';
const classesFilePath = './classes.json';
const completedContentFilePath = './completed-content.json';

async function main() {
    console.log("--- Lancement du script d'importation AIDA ---");
    if (!endpoint || !key) {
        return console.error("ERREUR : Variables .env manquantes.");
    }
    const client = new CosmosClient({ endpoint, key });

    try {
        console.log(`Création de la BDD '${databaseId}' avec budget partagé...`);
        const { database } = await client.databases.createIfNotExists({ id: databaseId, throughput: 400 });
        
        await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
        await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
        await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });

        console.log("✅ Base de données et conteneurs prêts.");

        const usersContainer = database.container(usersContainerId);
        const classesContainer = database.container(classesContainerId);
        const completedContentContainer = database.container(completedContentContainerId);

        const usersData = JSON.parse(await fs.readFile(usersFilePath, 'utf-8'));
        console.log(`\nImportation de ${usersData.length} utilisateurs...`);
        for (const user of usersData) await usersContainer.items.upsert(user);
        
        const classesData = JSON.parse(await fs.readFile(classesFilePath, 'utf-8'));
        console.log(`Importation de ${classesData.length} classes...`);
        for (const classItem of classesData) await classesContainer.items.upsert(classItem);

        const completedData = JSON.parse(await fs.readFile(completedContentFilePath, 'utf-8'));
        console.log(`Importation de ${completedData.length} contenus terminés...`);
        for (const item of completedData) await completedContentContainer.items.upsert(item);

    } catch (error) {
        console.error("\n--- ERREUR ---", error);
    } finally {
        console.log("\n--- Script terminé ---");
    }
}
main();

