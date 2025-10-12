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

    if (result.status !== '200') {
        console.error("Erreur de l'API Azure Vision:", result.body);
        throw new Error(`L'analyse d'image a échoué (statut: ${result.status}). Veuillez vérifier que les clés d'API et le point de terminaison de vision sont corrects dans la configuration de votre application Azure.`);
    }

    if (result.body.readResult && result.body.readResult.blocks.length > 0) {
        return result.body.readResult.blocks.map(block => block.lines.map(line => line.text).join(' ')).join('\n');
    }
    return '';
}

// --- 5. Routes API ---

// AUTHENTIFICATION
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

// ENSEIGNANT
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
            if (student) {
                return { email: student.email, firstName: student.firstName, avatar: student.avatar };
            }
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
        
        const { resource: classDoc } = await classesContainer.item(classId, student.teacherEmail).read();
        if (!classDoc) return res.status(404).json({ error: "Classe non trouvée." });
        if (classDoc.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });
        
        classDoc.students.push(studentEmail);
        await classesContainer.item(classId, classDoc.teacherEmail).replace(classDoc);
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

// ÉLÈVE
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

// IA
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
            quiz: `À partir du texte suivant...`,
            exercices: `À partir du texte suivant...`
        };
        const prompt = promptMap[contentType];
        
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        let structured_content = JSON.parse(jsonString);
        res.json({ structured_content });

    } catch (error) {
        console.error("Erreur lors du traitement du fichier uploadé:", error);
        res.status(500).json({ error: error.message || "Une erreur est survenue lors de l'analyse du document." });
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
        res.status(500).json({ error: error.message || "Une erreur est survenue lors de l'analyse du document." });
    }
});

app.post('/api/ai/correct-exercise', async (req, res) => {
    const { exerciseText, studentAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !exerciseText || studentAnswer === undefined) {
        return res.status(400).json({ error: "Texte de l'exercice et réponse de l'élève requis." });
    }

    const prompt = `Corrige cet exercice...`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ correction: response.data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la génération de la correction." });
    }
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

