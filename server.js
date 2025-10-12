// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
// NOUVELLE IMPORTATION pour Document Intelligence
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
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
    // ... (code inchangé)
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
    console.warn("La chaîne de connexion Azure Storage n'est pas définie.");
}
const blobServiceClient = storageConnectionString ? BlobServiceClient.fromConnectionString(storageConnectionString) : null;
const containerName = 'documents';

async function setupBlobStorage() {
    // ... (code inchangé)
    if (!blobServiceClient) return;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    console.log("Conteneur Blob Storage prêt.");
}

// NOUVELLE CONFIGURATION : Azure AI Document Intelligence
const docIntelEndpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
const docIntelKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
let docIntelClient;
if (docIntelEndpoint && docIntelKey) {
    docIntelClient = new DocumentAnalysisClient(docIntelEndpoint, new AzureKeyCredential(docIntelKey));
    console.log("Client Azure Document Intelligence prêt.");
} else {
    console.warn("Les informations de connexion Azure Document Intelligence ne sont pas définies.");
}

// --- 3. Initialisation Express ---
const app = express();
app.use(cors()); // La configuration fine se fait sur le portail Azure.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 4. Fonctions Utilitaires (MISE À JOUR) ---
async function extractTextFromBuffer(buffer) {
    if (!docIntelClient) {
        throw new Error("Le service d'analyse de documents n'est pas configuré.");
    }
    
    try {
        const poller = await docIntelClient.beginAnalyzeDocument("prebuilt-read", buffer);
        const { content } = await poller.pollUntilDone();
        return content;
    } catch (error) {
        console.error("Erreur détaillée de Document Intelligence:", error);
        throw new Error("L'analyse du document a échoué. Vérifiez que le format du fichier est supporté (PDF, JPEG, PNG, DOCX...) et que les clés d'API sont correctes.");
    }
}

// --- 5. Routes API ---
// Le reste des routes est identique. Seules les routes d'upload utilisent la nouvelle fonction.

// AUTHENTIFICATION (inchangé)
app.post('/api/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: "Email, mot de passe et rôle sont requis." });
    try {
        const { resource: existingUser } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (existingUser) return res.status(409).json({ error: "Cet email est déjà utilisé." });
        const nameParts = email.split('@')[0].split('.').map(part => part.charAt(0).toUpperCase() + part.slice(1));
        const firstName = nameParts[0] || "Nouvel";
        const lastName = nameParts[1] || "Utilisateur";
        const defaultAvatar = 'default-student.png';
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


// IA (ROUTES MISES À JOUR)
app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!blobServiceClient || !docIntelClient) return res.status(500).json({ error: "Les services Azure ne sont pas configurés." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });

    try {
        const blobName = `teacher-upload-${new Date().getTime()}-${req.file.originalname}`;
        await blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName).uploadData(req.file.buffer);
        console.log(`Fichier ${blobName} téléversé.`);
        
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) return res.status(400).json({ error: "Impossible d'extraire du texte de ce document." });
        
        // ... reste de la logique de génération (inchangée) ...
        const { contentType, exerciseCount } = req.body;
        const apiKey = process.env.DEEPSEEK_API_KEY;
        const promptMap = {
            quiz: `À partir du texte suivant, crée un quiz. Format JSON: {"title": "Quiz sur le document", "type": "quiz", "questions": [...]}. Texte: "${extractedText}"`,
            exercices: `À partir du texte suivant, crée ${exerciseCount || 5} exercices. Format JSON: {"title": "Exercices sur le document", "type": "exercices", "content": [...]}. Texte: "${extractedText}"`
        };
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: promptMap[contentType], role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let structured_content = JSON.parse(response.data.choices[0].message.content.replace(/```json\n|\n```/g, ''));
        res.json({ structured_content });

    } catch (error) {
        console.error("Erreur upload enseignant:", error);
        res.status(500).json({ error: error.message || "Erreur interne." });
    }
});

app.post('/api/ai/extract-text-from-student-doc', upload.single('document'), async (req, res) => {
    if (!blobServiceClient || !docIntelClient) return res.status(500).json({ error: "Les services Azure ne sont pas configurés." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });
    
    try {
        const blobName = `student-upload-${new Date().getTime()}-${req.file.originalname}`;
        await blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName).uploadData(req.file.buffer);
        console.log(`Fichier élève ${blobName} téléversé.`);
        
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) return res.status(400).json({ error: "Impossible de lire le texte dans ce document." });
        
        res.json({ extractedText });
    } catch (error) {
        console.error("Erreur upload élève:", error);
        res.status(500).json({ error: error.message || "Erreur interne." });
    }
});

// ... (toutes les autres routes restent ici, inchangées) ...
app.get('/api/teacher/classes', async (req, res) => {
    const { teacherEmail } = req.query;
    if (!teacherEmail) return res.status(400).json({ error: "L'email de l'enseignant est requis." });
    const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.status(200).json(classes);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});

app.post('/api/teacher/classes', async (req, res) => {
    const { className, teacherEmail } = req.body;
    if (!className || !teacherEmail) return res.status(400).json({ error: "Nom de classe et email du professeur sont requis." });
    const newClass = { id: `class-${Date.now()}`, className, teacherEmail, students: [], content: [], results: [] };
    try {
        const { resource: createdClass } = await classesContainer.items.create(newClass);
        res.status(201).json(createdClass);
    } catch (error) { res.status(500).json({ error: "Impossible de créer la classe." }); }
});

app.get('/api/teacher/classes/:classId', async (req, res) => {
    const { classId } = req.params;
    const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
    try {
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        
        const classDoc = resources[0];
        const studentDetailsPromises = (classDoc.students || []).map(async (email) => {
            const { resource: student } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
            if (student) return { email: student.email, firstName: student.firstName, avatar: student.avatar };
            return null;
        });
        const studentsWithDetails = (await Promise.all(studentDetailsPromises)).filter(Boolean);
        
        res.status(200).json({ ...classDoc, studentsWithDetails });
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les détails de la classe." }); }
});

app.post('/api/teacher/classes/:classId/add-student', async (req, res) => {
    const { classId } = req.params;
    const { studentEmail } = req.body;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });
    try {
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read().catch(() => ({ resource: null }));
        if (!student || student.role !== 'student') return res.status(404).json({ error: "Aucun élève trouvé avec cet email." });
        
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });

        const classDoc = resources[0];
        if (classDoc.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });
        
        classDoc.students.push(studentEmail);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Élève ajouté avec succès." });
    } catch (error) { res.status(500).json({ error: "Impossible d'ajouter l'élève." }); }
});

app.post('/api/teacher/assign-content', async (req, res) => {
    const { classId, contentData } = req.body;
    if (!classId || !contentData) return res.status(400).json({ error: "ID de classe et contenu sont requis." });
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });

        const classDoc = resources[0];
        const newContent = { ...contentData, id: `content-${Date.now()}`, assignedAt: new Date().toISOString() };
        if (!classDoc.content) classDoc.content = [];
        classDoc.content.push(newContent);
        
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json(newContent);
    } catch (error) { res.status(500).json({ error: "Impossible d'assigner le contenu." }); }
});

app.get('/api/student/dashboard', async (req, res) => {
    const { studentEmail } = req.query;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });
    try {
        const classQuery = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: '@studentEmail', value: studentEmail }] };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        const completedQuery = { query: "SELECT * FROM c WHERE c.studentEmail = @studentEmail", parameters: [{ name: "@studentEmail", value: studentEmail }] };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedMap = new Map(completedItems.map(item => [item.contentId, item.completedAt]));

        let allContent = [];
        classes.forEach(c => { (c.content || []).forEach(cont => allContent.push({ ...cont, className: c.className, classId: c.id })); });
        
        const todo = allContent.filter(cont => !completedMap.has(cont.id));
        const completed = allContent.filter(cont => completedMap.has(cont.id)).map(cont => ({ ...cont, completedAt: completedMap.get(cont.id) }));
        
        res.status(200).json({ todo, completed });
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer le tableau de bord." }); }
});

app.post('/api/student/submit-quiz', async (req, res) => {
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers } = req.body;
    
    const completedItem = { id: `${studentEmail}-${contentId}`, studentEmail, contentId, completedAt: new Date().toISOString() };
    await completedContentContainer.items.upsert(completedItem);

    const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
    const { resources } = await classesContainer.items.query(querySpec).fetchAll();
    if (resources.length > 0) {
        const classDoc = resources[0];
        const newResult = { studentEmail, contentId, title, score, totalQuestions, submittedAt: completedItem.completedAt, answers };
        if (!classDoc.results) classDoc.results = [];
        classDoc.results.push(newResult);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
    }
    res.status(201).json(completedItem);
});

app.post('/api/ai/correct-exercise', async (req, res) => {
    const { exerciseText, studentAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !exerciseText) return res.status(400).json({ error: "Données incomplètes." });

    const prompt = `Corrige cet exercice: "${exerciseText}". Réponse de l'élève: "${studentAnswer}". Sois encourageant.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ correction: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "Erreur de correction." }); }
});

app.get('/', (req, res) => {
    res.send('<h1>Le serveur AIDA est en ligne !</h1>');
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

