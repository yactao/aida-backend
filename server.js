// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');

// --- 2. Initialisation Cosmos DB ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint, key });

const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

let usersContainer, classesContainer, completedContentContainer;

async function setupDatabase() {
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container: uc } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
    const { container: cc } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
    const { container: ccc } = await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });
    
    usersContainer = uc;
    classesContainer = cc;
    completedContentContainer = ccc;
    console.log("Base de données et conteneurs prêts.");
}

// --- 3. Initialisation Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Sert les fichiers dans le dossier 'public'

const apiRouter = express.Router();

// --- 4. Routes API ---

// A. Authentification
apiRouter.post('/auth/signup', async (req, res) => {
    // ... Logique d'inscription ...
});
apiRouter.post('/auth/login', async (req, res) => {
    // ... Logique de connexion ...
});

// B. Routes Professeur
apiRouter.get('/teacher/classes', async (req, res) => {
    // ... Récupérer les classes d'un prof ...
});
apiRouter.post('/teacher/classes', async (req, res) => {
    // ... Créer une nouvelle classe ...
});
apiRouter.get('/teacher/classes/:classId', async (req, res) => {
    // ... Détails d'une classe ...
});
apiRouter.post('/teacher/classes/:classId/students', async (req, res) => {
    // ... Ajouter un élève ...
});
apiRouter.delete('/teacher/classes/:classId/students/:studentEmail', async (req, res) => {
    // ... Retirer un élève ...
});
apiRouter.delete('/teacher/classes/:classId', async (req, res) => {
    // ... Supprimer une classe ...
});
apiRouter.post('/teacher/classes/:classId/assign', async (req, res) => {
    // ... Assigner du contenu ...
});

// C. Routes Élève
apiRouter.get('/student/dashboard', async (req, res) => {
    // ... Récupérer le tableau de bord de l'élève (à faire/terminé) ...
});
apiRouter.post('/student/submit', async (req, res) => {
    // ... Soumettre les résultats d'un quiz ...
});

// D. Routes IA
apiRouter.post('/ai/generate-content', async (req, res) => {
    // ... Générer du contenu pédagogique ...
});
apiRouter.post('/ai/playground-chat', async (req, res) => {
    // ... Gérer la conversation du Playground ...
});
apiRouter.post('/ai/quiz-hint', async (req, res) => {
    // ... Fournir un indice pour un quiz ...
});

app.use('/api', apiRouter);

// --- 5. Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
setupDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error);
    process.exit(1);
});

