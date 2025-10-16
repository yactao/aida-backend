// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
const { AzureKeyCredential } = require('@azure/core-auth');
const multer = require('multer');

// --- 2. Initialisation des Services Azure ---
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });

const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';

let usersContainer, classesContainer;

async function setupDatabase() {
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container: uc } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
    const { container: cc } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
    
    usersContainer = uc;
    classesContainer = cc;
    console.log("Base de données et conteneurs prêts.");
}

const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobServiceClient = storageConnectionString ? BlobServiceClient.fromConnectionString(storageConnectionString) : null;
const containerName = 'documents';

async function setupBlobStorage() {
    if (!blobServiceClient) return;
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    console.log("Conteneur Blob Storage prêt.");
}

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
app.use(cors());
// Augmenter la limite de la taille du payload pour les images en base64
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 4. Fonctions Utilitaires ---
async function cleanUpOcrText(rawText) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Clé API DeepSeek non configurée.");

    const prompt = `Tu es un assistant spécialisé dans le formatage de texte. Le texte suivant provient d'une reconnaissance optique (OCR) d'une feuille d'exercices et il est désordonné. Ta mission est de le reformater pour présenter clairement chaque exercice, un par un. Ignore les nombres qui semblent être les réponses déjà écrites sur la feuille. Ne garde que les énoncés. Voici le texte : "${rawText}"`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] },
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erreur lors du nettoyage du texte par l'IA:", error);
        return rawText;
    }
}

async function extractTextFromBuffer(buffer) {
    if (!docIntelClient) throw new Error("Le service d'analyse de documents n'est pas configuré.");
    
    try {
        const poller = await docIntelClient.beginAnalyzeDocument("prebuilt-read", buffer);
        const { pages } = await poller.pollUntilDone();
        if (!pages || pages.length === 0) return "";
        
        const rawText = pages.map(page => page.lines.map(line => line.content).join(' ')).join('\n\n');
        return await cleanUpOcrText(rawText);

    } catch (error) {
        console.error("Erreur détaillée de Document Intelligence:", error);
        throw new Error("L'analyse du document a échoué. Vérifiez le format du fichier et les clés d'API.");
    }
}


// --- 5. Routes API ---
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
        res.status(200).json({ user });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la connexion." }); }
});

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

app.post('/api/teacher/classes/reorder', async (req, res) => {
    const { teacherEmail, classOrder } = req.body;
    if (!teacherEmail || !Array.isArray(classOrder)) {
        return res.status(400).json({ error: "L'email de l'enseignant et un ordre de classe sont requis." });
    }

    try {
        const { resource: user } = await usersContainer.item(teacherEmail, teacherEmail).read();
        if (!user) {
            return res.status(404).json({ error: "Enseignant non trouvé." });
        }

        user.classOrder = classOrder;

        const { resource: updatedUser } = await usersContainer.item(teacherEmail, teacherEmail).replace(user);

        res.status(200).json({ message: "L'ordre des classes a été sauvegardé.", classOrder: updatedUser.classOrder });
    } catch (error) {
        console.error("Erreur lors de la réorganisation des classes:", error);
        res.status(500).json({ error: "Impossible de sauvegarder le nouvel ordre des classes." });
    }
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

app.post('/api/teacher/classes/:classId/remove-student', async (req, res) => {
    const { classId } = req.params;
    const { studentEmail } = req.body;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });

    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });

        const classDoc = resources[0];

        const initialStudentCount = (classDoc.students || []).length;
        classDoc.students = (classDoc.students || []).filter(email => email !== studentEmail);
        if (classDoc.students.length === initialStudentCount) {
            console.log(`L'élève ${studentEmail} n'a pas été trouvé dans la liste des élèves de la classe ${classId}.`);
        }

        classDoc.results = (classDoc.results || []).filter(result => result.studentEmail !== studentEmail);

        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        
        res.status(200).json({ message: "Élève supprimé avec succès." });

    } catch (error) {
        console.error("Erreur suppression élève:", error);
        res.status(500).json({ error: "Impossible de supprimer l'élève." });
    }
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

app.delete('/api/teacher/classes/:classId/content/:contentId', async (req, res) => {
    const { classId, contentId } = req.params;
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        
        if (resources.length === 0) {
            return res.status(404).json({ error: "Classe non trouvée." });
        }

        const classDoc = resources[0];
        classDoc.content = (classDoc.content || []).filter(c => c.id !== contentId);
        classDoc.results = (classDoc.results || []).filter(r => r.contentId !== contentId);

        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Contenu supprimé avec succès." });
    } catch (error) {
        console.error("Erreur lors de la suppression du contenu:", error);
        res.status(500).json({ error: "Erreur serveur lors de la suppression du contenu." });
    }
});

app.get('/api/teacher/classes/:classId/competency-report', async (req, res) => {
    const { classId } = req.params;
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        
        const classDoc = resources[0];
        const results = classDoc.results || [];
        const contents = classDoc.content || [];
        const competencyData = {};

        results.forEach(result => {
            const content = contents.find(c => c.id === result.contentId);
            if (content && content.competence && content.competence.competence) {
                const { competence, level } = content.competence;
                if (!competencyData[competence]) {
                    competencyData[competence] = { scores: [], count: 0, level };
                }
                if (result.totalQuestions > 0) {
                    const scorePercentage = (result.score / result.totalQuestions) * 100;
                    competencyData[competence].scores.push(scorePercentage);
                    competencyData[competence].count++;
                }
            }
        });

        const report = Object.keys(competencyData).map(competence => {
            const data = competencyData[competence];
            const averageScore = data.scores.length > 0 ? data.scores.reduce((sum, score) => sum + score, 0) / data.scores.length : 0;
            return { competence, level: data.level, averageScore: Math.round(averageScore), submissionCount: data.count };
        });

        res.status(200).json(report);
    } catch (error) {
        console.error("Erreur rapport de compétences:", error);
        res.status(500).json({ error: "Impossible de générer le rapport." });
    }
});

app.delete('/api/teacher/classes/:classId/content/:contentId', async (req, res) => {
    const { classId, contentId } = req.params;
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        
        if (resources.length === 0) {
            return res.status(404).json({ error: "Classe non trouvée." });
        }

        const classDoc = resources[0];
        classDoc.content = (classDoc.content || []).filter(c => c.id !== contentId);
        classDoc.results = (classDoc.results || []).filter(r => r.contentId !== contentId);

        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Contenu supprimé avec succès." });
    } catch (error) {
        console.error("Erreur lors de la suppression du contenu:", error);
        res.status(500).json({ error: "Erreur serveur lors de la suppression du contenu." });
    }
});


app.get('/api/student/dashboard', async (req, res) => {
    const { studentEmail } = req.query;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });
    try {
        const classQuery = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: '@studentEmail', value: studentEmail }] };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        let allContent = [];
        let studentResults = [];
        classes.forEach(c => { 
            (c.content || []).forEach(cont => allContent.push({ ...cont, className: c.className, classId: c.id })); 
            (c.results || []).filter(r => r && r.studentEmail === studentEmail).forEach(res => studentResults.push(res));
        });

        const resultMap = new Map(studentResults.map(res => [res.contentId, res]));

        const todo = [];
        const pending = [];
        const completed = [];

        allContent.forEach(content => {
            if (resultMap.has(content.id)) {
                const result = resultMap.get(content.id);
                if (result && result.submittedAt) {
                    const item = { ...content, ...result, completedAt: result.submittedAt };
                    if (result.status === 'pending_validation') {
                        pending.push(item);
                    } else {
                        completed.push(item);
                    }
                }
            } else {
                todo.push(content);
            }
        });
        
        res.status(200).json({ todo, pending, completed });
    } catch (error) { 
        console.error("Erreur API /student/dashboard:", error);
        res.status(500).json({ error: "Impossible de récupérer le tableau de bord." }); 
    }
});

app.post('/api/student/submit-quiz', async (req, res) => {
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers, helpUsed } = req.body;

    const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
    const { resources } = await classesContainer.items.query(querySpec).fetchAll();
    if (resources.length > 0) {
        const classDoc = resources[0];
        const newResult = { 
            studentEmail, 
            contentId, 
            title, 
            score, 
            totalQuestions, 
            submittedAt: new Date().toISOString(), 
            answers, 
            helpUsed,
            status: 'pending_validation'
        };
        if (!classDoc.results) classDoc.results = [];
        classDoc.results.push(newResult);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(201).json(newResult);
    } else {
        res.status(404).json({error: "Classe non trouvée lors de la soumission."})
    }
});

app.post('/api/teacher/validate-result', async (req, res) => {
    const { classId, teacherEmail, studentEmail, contentId, appreciation, comment } = req.body;
    if (!classId || !teacherEmail || !studentEmail || !contentId || !appreciation) {
        return res.status(400).json({ error: "Données de validation incomplètes." });
    }

    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        if (!classDoc) {
            return res.status(404).json({ error: "Classe non trouvée." });
        }

        const resultIndex = (classDoc.results || []).findIndex(r => r.studentEmail === studentEmail && r.contentId === contentId);
        if (resultIndex === -1) {
            return res.status(404).json({ error: "Résultat non trouvé." });
        }

        classDoc.results[resultIndex].status = 'validated';
        classDoc.results[resultIndex].appreciation = appreciation;
        classDoc.results[resultIndex].teacherComment = comment || '';
        classDoc.results[resultIndex].validatedAt = new Date().toISOString();

        await classesContainer.item(classId, teacherEmail).replace(classDoc);

        res.status(200).json({ message: "Validation enregistrée." });

    } catch (error) {
        console.error("Erreur lors de la validation:", error);
        res.status(500).json({ error: "Erreur serveur lors de la validation." });
    }
});


app.post('/api/ai/generate-content', async (req, res) => {
    const { competences, contentType, exerciseCount } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !competences || !contentType) {
        return res.status(400).json({ error: "Compétences et type de contenu sont requis." });
    }

    const promptMap = {
        quiz: `Crée un quiz de ${exerciseCount} questions sur "${competences}". Format JSON: {"title": "Titre", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`,
        exercices: `Crée une fiche de ${exerciseCount} exercices sur "${competences}". Format JSON: {"title": "Titre", "type": "exercices", "content": [{"enonce": "..."}]}`,
        revision: `Crée une fiche de révision synthétique sur "${competences}". Format JSON: {"title": "Titre", "type": "revision", "content": "Texte de la fiche..."}`,
        dm: `Crée un devoir maison de ${exerciseCount} exercices approfondis sur "${competences}". Format JSON: {"title": "Titre", "type": "dm", "content": [{"enonce": "..."}]}`
    };
    const prompt = promptMap[contentType];
    if (!prompt) return res.status(400).json({ error: "Type de contenu non valide." });

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] },
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        let structured_content = JSON.parse(jsonString);
        res.json({ structured_content });
    } catch (error) {
        console.error("Erreur génération de contenu:", error);
        res.status(500).json({ error: "Erreur lors de la génération du contenu." });
    }
});

app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!blobServiceClient || !docIntelClient) return res.status(500).json({ error: "Les services Azure ne sont pas configurés." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });

    try {
        const blobName = `teacher-upload-${new Date().getTime()}-${req.file.originalname}`;
        await blobServiceClient.getContainerClient(containerName).getBlockBlobClient(blobName).uploadData(req.file.buffer);
        console.log(`Fichier ${blobName} téléversé.`);
        
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) return res.status(400).json({ error: "Impossible d'extraire du texte de ce document." });
        
        const { contentType, exerciseCount } = req.body;
        const apiKey = process.env.DEEPSEEK_API_KEY;
        
        const promptMap = {
            quiz: `À partir du texte suivant, crée un quiz de ${exerciseCount} questions. Le format de la réponse DOIT ÊTRE un JSON valide et rien d'autre. Le JSON doit avoir cette structure exacte : {"title": "Quiz sur le document", "type": "quiz", "questions": [{"question_text": "Texte de la question", "options": ["Option A", "Option B", "Option C", "Option D"], "correct_answer_index": 0}]}. Ne change AUCUN nom de clé. Voici le texte: "${extractedText}"`,
            exercices: `À partir du texte suivant, crée une fiche de ${exerciseCount} exercices. Format JSON: {"title": "Titre", "type": "exercices", "content": [{"enonce": "..."}]}. Voici le texte: "${extractedText}"`,
            revision: `À partir du texte suivant, crée une fiche de révision synthétique. Format JSON: {"title": "Titre", "type": "revision", "content": "Texte de la fiche..."}. Voici le texte: "${extractedText}"`,
            dm: `À partir du texte suivant, crée un devoir maison de ${exerciseCount} exercices approfondis. Format JSON: {"title": "Titre", "type": "dm", "content": [{"enonce": "..."}]}. Voici le texte: "${extractedText}"`
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

app.post('/api/ai/get-hint', async (req, res) => {
    const { questionText } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !questionText) {
        return res.status(400).json({ error: "Texte de la question requis." });
    }

    const prompt = `Pour la question suivante: "${questionText}", donne un indice simple et court qui aide à réfléchir sans donner la réponse.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] },
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la génération de l'indice." });
    }
});

app.post('/api/ai/get-feedback-for-error', async (req, res) => {
    const { question, userAnswer, correctAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !question || !correctAnswer) {
        return res.status(400).json({ error: "Données incomplètes pour la correction." });
    }

    const prompt = `Pour la question "${question}", l'élève a répondu "${userAnswer}" alors que la bonne réponse était "${correctAnswer}". Explique simplement et de manière encourageante pourquoi sa réponse est incorrecte et pourquoi l'autre est correcte, sans être trop long.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] },
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ feedback: response.data.choices[0].message.content });
    } catch (error) {
        console.error("Erreur lors de la génération du feedback:", error);
        res.status(500).json({ error: "Erreur lors de la génération du feedback." });
    }
});

app.post('/api/ai/playground-chat', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    const systemPrompt = `
        Tu es AÏDA, un tuteur pédagogique bienveillant, patient et encourageant. Ton objectif principal n'est PAS de donner la réponse, mais de guider l'élève vers la solution par lui-même.

        Adapte ton langage et la complexité de tes explications au niveau apparent de l'élève (utilise un langage simple et direct pour un enfant, plus structuré pour un lycéen).

        Ta méthode de guidage doit toujours suivre ces étapes :
        1.  **Questionner d'abord :** Ne réponds jamais directement. Commence toujours par poser une question ouverte pour comprendre où l'élève bloque. Exemples : "Qu'as-tu déjà essayé de faire ?", "Quelle partie de la consigne n'est pas claire pour toi ?", "À quoi te fait penser ce problème ?".
        2.  **Donner un indice subtil :** Si l'élève est perdu, donne-lui une piste de réflexion, un angle d'attaque ou une question plus ciblée. Exemples : "As-tu pensé à dessiner la situation ?", "Relis bien le deuxième paragraphe, une information importante s'y cache.", "Cette forme géométrique ne te rappelle rien ?".
        3.  **Valider et approfondir :** Quand l'élève trouve la bonne réponse, félicite-le et demande-lui d'expliquer son raisonnement pour t'assurer qu'il a bien compris le concept. Exemple: "Bravo, c'est la bonne réponse ! Peux-tu m'expliquer comment tu y es arrivé ?".
        4.  **Donner la réponse en dernier recours :** Si, et seulement si, l'élève le demande explicitement après plusieurs tentatives infructueuses, donne la réponse. Mais accompagne-la TOUJOURS d'une explication claire, simple et détaillée du raisonnement pour qu'il puisse comprendre.
    `;

    // Ajouter le prompt système au début de l'historique s'il n'y est pas déjà.
    if (history[0].role !== 'system') {
        history.unshift({ role: 'system', content: systemPrompt });
    } else {
        history[0].content = systemPrompt; // Toujours s'assurer que le prompt système est le bon.
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: history }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ reply: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "Erreur de communication avec AIDA." }); }
});

app.post('/api/ai/playground-extract-text', upload.single('document'), async (req, res) => {
    if (!docIntelClient) return res.status(500).json({ error: "Le service d'analyse de document n'est pas configuré." });
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été téléversé." });

    try {
        const extractedText = await extractTextFromBuffer(req.file.buffer);
        if (!extractedText) return res.status(400).json({ error: "Impossible de lire le texte dans ce document." });
        
        res.json({ extractedText });
    } catch (error) {
        console.error("Erreur lors de l'extraction de texte du playground:", error);
        res.status(500).json({ error: error.message || "Erreur interne lors de l'analyse du document." });
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


