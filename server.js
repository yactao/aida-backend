// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const ImageAnalysisClient = require('@azure-rest/ai-vision-image-analysis').default;
const { AzureKeyCredential } = require('@azure/core-auth');
const multer = require('multer');

// --- 2. Initialisation des Services Azure ---
// Cosmos DB
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });

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

// Azure Blob Storage
const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!storageConnectionString) {
    console.warn("La chaîne de connexion Azure Storage n'est pas définie. Le téléversement de fichiers sera désactivé.");
}
const blobServiceClient = storageConnectionString ? BlobServiceClient.fromConnectionString(storageConnectionString) : null;
const containerName = 'documents';

async function setupBlobStorage() {
    if (!blobServiceClient) return;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    console.log("Conteneur Blob Storage prêt.");
}

// Azure AI Vision
const visionEndpoint = process.env.AZURE_VISION_ENDPOINT;
const visionKey = process.env.AZURE_VISION_KEY;
let visionClient;
if (visionEndpoint && visionKey) {
    visionClient = ImageAnalysisClient(visionEndpoint, new AzureKeyCredential(visionKey));
    console.log("Client Azure AI Vision prêt.");
} else {
    console.warn("Les informations de connexion Azure AI Vision ne sont pas définies. L'analyse de documents sera désactivée.");
}

// --- 3. Initialisation Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 4. Fonctions Utilitaires ---
async function extractTextFromBuffer(buffer) {
    if (!visionClient) throw new Error("Le service d'analyse d'image n'est pas configuré.");
    
    const result = await visionClient.path('/imageanalysis:analyze').post({
        body: buffer,
        queryParameters: { features: ['read'] },
        headers: { 'Content-Type': 'application/octet-stream' }
    });

    if (result.status === '200' && result.body.readResult) {
        return result.body.readResult.blocks.map(block => block.lines.map(line => line.text).join(' ')).join('\n');
    }
    return '';
}

// --- 5. Routes API (le reste du code est inchangé) ---

app.post('/api/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: "Email, mot de passe et rôle sont requis." });
    try {
        const { resource: existingUser } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (existingUser) return res.status(409).json({ error: "Cet email est déjà utilisé." });
        const nameParts = email.split('@')[0].split('.').map(part => part.charAt(0).toUpperCase() + part.slice(1));
        const firstName = nameParts[0] || "Nouvel";
        const lastName = nameParts[1] || "Utilisateur";
        const defaultAvatar = role === 'teacher' ? 'default-teacher.png' : 'default-student.png';
        const newUser = { id: email, email, password, role, classes: [], firstName, lastName, avatar: defaultAvatar };
        await usersContainer.items.create(newUser);
        res.status(201).json({ user: { email, role, firstName, avatar: defaultAvatar } });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la création du compte." }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email et mot de passe sont requis." });
    try {
        const { resource: user } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (!user || user.password !== password) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        res.status(200).json({ user: { email: user.email, role: user.role, firstName: user.firstName, avatar: user.avatar } });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la connexion." }); }
});

app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!blobServiceClient || !visionClient) return res.status(500).json({ error: "Les services Azure ne sont pas configurés." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });

    try {
        const blobName = `teacher-upload-${new Date().getTime()}-${req.file.originalname}`;
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer);
        console.log(`Fichier ${blobName} téléversé sur Azure Blob Storage.`);
        
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) {
            return res.status(400).json({ error: "Impossible d'extraire du texte de ce document." });
        }
        
        const { contentType, exerciseCount } = req.body;
        const apiKey = process.env.DEEPSEEK_API_KEY;
        const promptMap = {
            quiz: `À partir du texte suivant, crée un quiz de 3 questions. Format JSON: {"title": "Quiz sur le document", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}. Texte: "${extractedText}"`,
            exercices: `À partir du texte suivant, crée ${exerciseCount || 5} exercices. Format JSON: {"title": "Exercices sur le document", "type": "exercices", "content": [{"enonce": "..."}]}. Texte: "${extractedText}"`
        };
        const prompt = promptMap[contentType];
        
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        let structured_content = JSON.parse(jsonString);
        res.json({ structured_content });

    } catch (error) {
        console.error("Erreur lors du traitement du fichier uploadé:", error);
        res.status(500).json({ error: "Une erreur est survenue lors de l'analyse du document." });
    }
});

app.post('/api/ai/extract-text-from-student-doc', upload.single('document'), async (req, res) => {
    if (!blobServiceClient || !visionClient) return res.status(500).json({ error: "Les services Azure ne sont pas configurés." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });
    
    try {
        const blobName = `student-upload-${new Date().getTime()}-${req.file.originalname}`;
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(req.file.buffer);
        console.log(`Fichier élève ${blobName} téléversé sur Azure Blob Storage.`);
        
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) {
             return res.status(400).json({ error: "Impossible de lire le texte dans ce document." });
        }
        
        res.json({ extractedText });
    } catch (error) {
        console.error("Erreur lors de l'extraction de texte du document élève:", error);
        res.status(500).json({ error: "Une erreur est survenue lors de l'analyse du document." });
    }
});


// --- 6. Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
Promise.all([setupDatabase(), setupBlobStorage()]).then(() => {
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error);
    process.exit(1);
});

