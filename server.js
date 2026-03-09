// --- Importations ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
const { AzureKeyCredential } = require('@azure/core-auth');
const multer = require('multer');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// --- Initialisation Express ---
const app = express();
const allowedOrigins = [
    'https://gray-meadow-0061b3603.1.azurestaticapps.net',
    'http://localhost:3000'
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- Clients de services ---
let dbClient, blobServiceClient, formRecognizerClient, ttsClient;

try {
    if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) throw new Error("COSMOS_ENDPOINT ou COSMOS_KEY manquant.");
    dbClient = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    console.log("Client Cosmos DB initialisé.");
} catch (e) { console.error("ERREUR Cosmos DB:", e.message); }

try {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error("AZURE_STORAGE_CONNECTION_STRING manquant.");
    blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    console.log("Client Blob Storage initialisé.");
} catch (e) { console.error("ERREUR Blob Storage:", e.message); }

try {
    if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || !process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY) throw new Error("Config Document Intelligence manquante.");
    formRecognizerClient = new DocumentAnalysisClient(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY));
    console.log("Client Document Intelligence initialisé.");
} catch (e) { console.error("ERREUR Document Intelligence:", e.message); }

try {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON manquant.");
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    ttsClient = new TextToSpeechClient({ credentials });
    console.log("Client Google Cloud TTS prêt.");
} catch (e) {
    console.warn("AVERTISSEMENT TTS:", e.message);
    ttsClient = null;
}

// --- Données par défaut ---
const defaultScenarios = [
    {
        id: 'scen-0',
        title: "Scénario 0 : Répétiteur Vocal (Phrases de Base)",
        language: "Arabe Littéraire (Al-Fusha)", level: "Débutant Absolu",
        context: "L'IA joue le rôle d'un tuteur amical et patient...",
        characterName: "Le Répétiteur (المُعِيد)",
        characterIntro: "أهلاً بك! هيا نتدرب على النطق. كرر هذه الجملة: أنا بخير. <PHONETIQUE>Ahlan bik! Hayyā natadarab 'alā an-nuṭq. Karrir hādhihi al-jumla: Anā bi-khayr.</PHONETIQUE> <TRADUCTION>Bienvenue ! Entraînons-nous à la prononciation. Répète cette phrase : Je vais bien.</TRADUCTION>",
        objectives: ["Répéter correctement 'Je vais bien'.", "Répéter correctement 'Merci'.", "Répéter correctement 'Quel est votre nom?'."],
        voiceCode: 'ar-XA-Wavenet-B'
    },
    {
        id: 'scen-1',
        title: "Scénario 1 : Commander son petit-déjeuner",
        language: "Arabe Littéraire (Al-Fusha)", level: "Débutant",
        context: "Vous entrez dans un café moderne au Caire...",
        characterName: "Le Serveur (النادِل)",
        characterIntro: "صباح الخير، تفضل. ماذا تود أن تطلب اليوم؟ <PHONETIQUE>Sabah al-khayr, tafaddal. Mādhā tawaddu an taṭlub al-yawm?</PHONETIQUE> <TRADUCTION>Bonjour, entrez. Que souhaitez-vous commander aujourd'hui ?</TRADUCTION>",
        objectives: ["Demander un thé et un croissant.", "Comprendre le prix total.", "Dire 'Merci' et 'Au revoir'."],
        voiceCode: 'ar-XA-Wavenet-B'
    }
];

// --- Etat partagé de la base de données ---
const db = {
    usersContainer: null,
    classesContainer: null,
    libraryContainer: null,
    scenariosContainer: null
};

async function initializeDatabase() {
    if (!dbClient) return console.error("Base de données non initialisée.");
    const database = dbClient.database('AidaDB');
    try {
        let result;
        result = await database.containers.createIfNotExists({ id: 'Users', partitionKey: '/id' });
        db.usersContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Classes', partitionKey: '/teacherEmail' });
        db.classesContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Library', partitionKey: '/subject' });
        db.libraryContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Scenarios', partitionKey: '/id' });
        db.scenariosContainer = result.container;
        console.log("Tous les conteneurs sont initialisés.");
    } catch (error) {
        console.error("Erreur critique lors de l'initialisation des conteneurs:", error.message);
        throw error;
    }
}

// --- Middleware d'authentification JWT ---
function requireAuth(req, res, next) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: "Authentification requise." });
    try {
        req.user = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: "Session expirée ou invalide." });
    }
}

// --- Route publique ---
app.get('/', (req, res) => {
    res.send('<h1>Serveur AIDA</h1><p>Le serveur est en ligne et fonctionne correctement.</p>');
});

// --- Protection globale /api (sauf routes publiques) ---
const PUBLIC_API_PATHS = ['/auth/login', '/auth/signup', '/auth/google', '/auth/forgot-password', '/auth/reset-password', '/academy/auth/login', '/academy/auth/signup', '/academy/auth/google'];
app.use('/api', (req, res, next) => {
    if (PUBLIC_API_PATHS.includes(req.path)) return next();
    requireAuth(req, res, next);
});

// --- Montage des modules de routes ---
const deps = { db, bcrypt, jwt, jwtSecret: JWT_SECRET, upload, ttsClient, formRecognizerClient, defaultScenarios };
app.use('/api', require('./routes/auth')(deps));
app.use('/api', require('./routes/education')(deps));
app.use('/api', require('./routes/library')(deps));
app.use('/api', require('./routes/ai')(deps));
app.use('/api', require('./routes/academy')(deps));

// --- Demarrage ---
const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
    app.listen(PORT, () => console.log(`Server AIDA démarré sur le port ${PORT}`));
}).catch((error) => {
    console.error("Le serveur ne peut pas démarrer:", error.message);
    process.exit(1);
});
