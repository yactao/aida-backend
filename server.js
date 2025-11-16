// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios =require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
const { AzureKeyCredential } = require('@azure/core-auth');
const multer = require('multer');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// --- 3. Initialisation Express ---
const app = express();
const allowedOrigins = [
    'https://gray-meadow-0061b3603.1.azurestaticapps.net',
    'http://localhost:3000'
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    }
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 2. Initialisation des Clients de Services ---
let dbClient, blobServiceClient, formRecognizerClient, ttsClient;

// ▼▼▼ MODIFICATION : Clients IA déclarés ici ▼▼▼
let aiApiDeepseek, aiApiKimi; 
// ▲▲▲ FIN MODIFICATION ▲▲▲

// Initialisation de chaque service dans son propre bloc try...catch
// Les services "optionnels" (TTS, Form Recognizer) passeront à 'null' en cas d'échec sans arrêter le serveur.
// Les services "critiques" (DB, IA) arrêteront le serveur s'ils ne peuvent pas s'initialiser.

try {
    if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) throw new Error("COSMOS_ENDPOINT ou COSMOS_KEY manquant.");
    dbClient = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    console.log("Client Cosmos DB initialisé.");
} catch(e) { 
    console.error("ERREUR CRITIQUE Cosmos DB:", e.message); 
    process.exit(1); // Critique
}

try {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error("AZURE_STORAGE_CONNECTION_STRING manquant.");
    blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    console.log("Client Blob Storage initialisé.");
} catch(e) { 
    console.error("ERREUR CRITIQUE Blob Storage:", e.message); 
    process.exit(1); // Critique
}

try {
    // Note : Vos variables s'appellent DOCUMENT_INTELLIGENCE
    if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || !process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY) throw new Error("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ou AZURE_DOCUMENT_INTELLIGENCE_KEY manquant.");
    formRecognizerClient = new DocumentAnalysisClient(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY));
    console.log("Client Document Intelligence initialisé.");
} catch(e) { 
    console.warn("AVERTISSEMENT Document Intelligence:", e.message); 
    formRecognizerClient = null; // Optionnel
}

try {
    // Note : Votre variable s'appelle GOOGLE_APPLICATION_CREDENTIALS_JSON
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) throw new Error("Variable d'environnement GOOGLE_APPLICATION_CREDENTIALS_JSON non trouvée.");
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    ttsClient = new TextToSpeechClient({ credentials });
    console.log("Client Google Cloud Text-to-Speech prêt (via JSON).");
} catch(e) {
    console.warn("AVERTISSEMENT Google Cloud TTS:", e.message);
    ttsClient = null; // Optionnel
}

// ▼▼▼ MODIFICATION : Initialisation des IA dans leurs propres blocs ▼▼▼
try {
    if (!process.env.DEEPSEEK_API_ENDPOINT || !process.env.DEEPSEEK_API_KEY) throw new Error("Variables Deepseek manquantes.");
    aiApiDeepseek = axios.create({
        baseURL: process.env.DEEPSEEK_API_ENDPOINT,
        headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }
    });
    console.log("Client IA (Deepseek) initialisé.");
} catch(e) {
    console.error("ERREUR CRITIQUE Deepseek:", e.message);
    process.exit(1); // Critique
}

try {
    if (!process.env.KIMI_API_ENDPOINT || !process.env.KIMI_API_KEY) throw new Error("Variables Kimi manquantes.");
    aiApiKimi = axios.create({
        baseURL: process.env.KIMI_API_ENDPOINT,
        headers: { 'Authorization': `Bearer ${process.env.KIMI_API_KEY}` }
    });
    console.log("Client IA (Kimi) initialisé.");
} catch(e) {
    console.error("ERREUR CRITIQUE Kimi:", e.message);
    process.exit(1); // Critique

// ▲▲▲ FIN DE LA MODIFICATION ▲▲▲


} catch (error) {
    console.error("Erreur critique lors de l'initialisation des clients de service:", error.message);
    process.exit(1); 
}

// --- 4. Initialisation de la Base de Données ---
let usersContainer, classesContainer, completedContentContainer, scenariosContainer;
async function initializeDatabase() {
    try {
        const { database } = await dbClient.databases.createIfNotExists({ id: "AidaDB" });
        const { container: usersCont } = await database.containers.createIfNotExists({ id: "Users", partitionKey: { paths: ["/email"] } });
        usersContainer = usersCont;
        const { container: classesCont } = await database.containers.createIfNotExists({ id: "Classes", partitionKey: { paths: ["/teacherEmail"] } });
        classesContainer = classesCont;
        const { container: completedCont } = await database.containers.createIfNotExists({ id: "CompletedContent", partitionKey: { paths: ["/studentEmail"] } });
        completedContentContainer = completedCont;
        const { container: scenariosCont } = await database.containers.createIfNotExists({ id: "AcademyScenarios", partitionKey: { paths: ["/teacherEmail"] } });
        scenariosContainer = scenariosCont;
        console.log("Conteneurs Cosmos DB (Users, Classes, CompletedContent, AcademyScenarios) prêts.");
    } catch (error) {
        console.error("Erreur lors de l'initialisation de Cosmos DB:", error.message);
        process.exit(1);
    }
}

// Middleware pour vérifier la BDD
app.use((req, res, next) => {
    if (!usersContainer || !classesContainer || !completedContentContainer || !scenariosContainer) {
        return res.status(503).json({ error: "Service de base de données non initialisé. Veuillez patienter." });
    }
    next();
});


// =======================================================================
// === AIDA ÉDUCATION : ROUTES API =======================================
// =======================================================================

// --- AUTHENTIFICATION (Éducation) ---
app.post('/api/auth/login', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        if (user && user.password === password) {
            const { password: _, ...userToReturn } = user;
            res.json({ user: userToReturn });
        } else {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        }
    } catch (error) {
        if (error.code === 404) {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        } else {
            res.status(500).json({ error: "Erreur serveur lors de la connexion." });
        }
    }
});

app.post('/api/auth/signup', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { email, password, role } = req.body;
    const newUser = {
        id: email,
        email,
        password: password, 
        role,
        firstName: email.split('@')[0],
        lastName: "",
        avatar: `default_${Math.ceil(Math.random() * 8)}.png`
    };
    try {
        const { resource: createdUser } = await usersContainer.items.create(newUser);
        const { password: _, ...userToReturn } = createdUser;
        res.status(201).json({ user: userToReturn });
    } catch (error) {
        if (error.code === 409) {
            res.status(409).json({ error: "Un utilisateur avec cet email existe déjà." });
        } else {
            res.status(500).json({ error: "Erreur lors de la création du compte." });
        }
    }
});

// --- ENSEIGNANT (Éducation) ---
app.get('/api/teacher/classes', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { teacherEmail } = req.query;
    if (!teacherEmail) {
        return res.status(400).json({ error: "Le 'teacherEmail' est manquant dans la requête." });
    }
    const querySpec = {
        query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail",
        parameters: [
            { name: "@teacherEmail", value: teacherEmail }
        ]
    };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.json(classes);
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur lors de la récupération des classes." });
    }
});

app.post('/api/teacher/classes', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { className, teacherEmail } = req.body;
    const newClass = {
        id: `class-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        className,
        teacherEmail,
        students: [],
        content: [],
        results: []
    };
    try {
        const { resource: createdClass } = await classesContainer.items.create(newClass);
        res.status(201).json(createdClass);
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur lors de la création de la classe." });
    }
});

app.get('/api/teacher/classes/:id', async (req, res) => {
    if (!classesContainer || !usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { id } = req.params;
    const { teacherEmail } = req.query;

    if (!teacherEmail) {
        return res.status(400).json({ error: "Le 'teacherEmail' est manquant dans la requête." });
    }

    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        
        if (classData && classData.students && classData.students.length > 0) {
            const studentEmails = classData.students;
            const querySpec = {
                query: `SELECT c.id, c.email, c.firstName, c.lastName, c.avatar FROM c WHERE ARRAY_CONTAINS(@studentEmails, c.email)`,
                parameters: [
                    { name: '@studentEmails', value: studentEmails }
                ]
            };
            const { resources: studentsWithDetails } = await usersContainer.items.query(querySpec).fetchAll();
            classData.studentsWithDetails = studentsWithDetails;
        } else if (classData) {
            classData.studentsWithDetails = [];
        }

        res.json(classData);
    } catch (error) {
        if (error.code === 404) {
            res.status(404).json({ error: "Classe non trouvée." });
        } else {
            res.status(500).json({ error: "Erreur serveur lors de la récupération de la classe." });
        }
    }
});

app.post('/api/teacher/classes/:id/add-student', async (req, res) => {
    if (!classesContainer || !usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { id } = req.params;
    const { studentEmail, teacherEmail } = req.body;

    try {
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student) {
            return res.status(404).json({ error: "Cet élève n'existe pas." });
        }

        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        if (!classData.students.includes(studentEmail)) {
            classData.students.push(studentEmail);
            await classesContainer.item(id, teacherEmail).replace(classData);
        }
        res.json(classData);
    } catch (error) {
        if (error.code === 404) {
            res.status(404).json({ error: "Classe ou élève non trouvé." });
        } else {
            res.status(500).json({ error: "Erreur serveur lors de l'ajout de l'élève." });
        }
    }
});

app.post('/api/teacher/classes/:id/remove-student', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { id } = req.params;
    const { studentEmail, teacherEmail } = req.body;

    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        classData.students = classData.students.filter(email => email !== studentEmail);
        classData.results = classData.results.filter(result => result.studentEmail !== studentEmail);
        
        await classesContainer.item(id, teacherEmail).replace(classData);
        res.status(200).json({ message: "Élève retiré avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur lors de la suppression de l'élève." });
    }
});

app.delete('/api/teacher/classes/:id/content/:contentId', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { id, contentId } = req.params;
    const { teacherEmail } = req.query;

    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        classData.content = classData.content.filter(c => c.id !== contentId);
        classData.results = classData.results.filter(r => r.contentId !== contentId);
        
        await classesContainer.item(id, teacherEmail).replace(classData);
        res.status(200).json({ message: "Contenu supprimé avec succès." });
    } catch (error) {
        res.status(500).json({ error: "Erreur serveur lors de la suppression du contenu." });
    }
});

app.post('/api/teacher/classes/reorder', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { teacherEmail, classOrder } = req.body;
    try {
        const { resource: user } = await usersContainer.item(teacherEmail, teacherEmail).read();
        user.classOrder = classOrder;
        await usersContainer.item(teacherEmail, teacherEmail).replace(user);
        res.json({ classOrder });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la sauvegarde de l'ordre des classes." });
    }
});

app.get('/api/teacher/classes/:id/competency-report', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { id } = req.params;
    const { teacherEmail } = req.query;

    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        const results = classData.results || [];
        const content = classData.content || [];
        
        const contentMap = new Map(content.map(c => [c.id, c]));
        const competencyScores = {};

        results.forEach(result => {
            if (result.status !== 'validated') return;
            const relatedContent = contentMap.get(result.contentId);
            if (!relatedContent || !relatedContent.competence || relatedContent.type !== 'quiz') return;

            const { competence, level } = relatedContent.competence;
            const score = (result.score / result.totalQuestions) * 100;

            if (!competencyScores[competence]) {
                competencyScores[competence] = { scores: [], level: level, count: 0 };
            }
            competencyScores[competence].scores.push(score);
            competencyScores[competence].count++;
        });

        const report = Object.keys(competencyScores).map(competence => {
            const data = competencyScores[competence];
            const averageScore = data.scores.reduce((a, b) => a + b, 0) / data.count;
            return {
                competence,
                level: data.level,
                averageScore: Math.round(averageScore)
            };
        });

        res.json(report);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la génération du rapport de compétences." });
    }
});

app.post('/api/teacher/assign-content', async (req, res) => {
    if (!classesContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { classId, teacherEmail, contentData } = req.body;
    
    const newContent = {
        id: `content-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        assignedAt: new Date().toISOString(),
        ...contentData
    };

    try {
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        classData.content.push(newContent);
        await classesContainer.item(classId, teacherEmail).replace(classData);
        res.status(201).json(newContent);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de l'assignation du contenu." });
    }
});

app.post('/api/teacher/validate-result', async (req, res) => {
    if (!classesContainer || !completedContentContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { classId, teacherEmail, studentEmail, contentId, appreciation, comment } = req.body;
    
    try {
        // Mettre à jour dans 'Classes'
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        const resultInClass = classData.results.find(r => r.studentEmail === studentEmail && r.contentId === contentId);
        if (resultInClass) {
            resultInClass.status = 'validated';
            resultInClass.appreciation = appreciation;
            resultInClass.teacherComment = comment;
            await classesContainer.item(classId, teacherEmail).replace(classData);
        }

        // Mettre à jour dans 'CompletedContent'
        const resultId = `${studentEmail}-${contentId}`;
        const { resource: resultData } = await completedContentContainer.item(resultId, studentEmail).read();
        if (resultData) {
            resultData.status = 'validated';
            resultData.appreciation = appreciation;
            resultData.teacherComment = comment;
            await completedContentContainer.item(resultId, studentEmail).replace(resultData);
        }
        
        res.status(200).json({ message: "Résultat validé." });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la validation." });
    }
});

// --- ÉLÈVE (Éducation) ---
app.get('/api/student/dashboard', async (req, res) => {
    if (!classesContainer || !completedContentContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { studentEmail } = req.query;

    const querySpecClasses = {
        query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)",
        parameters: [{ name: "@studentEmail", value: studentEmail }]
    };
    
    const querySpecResults = {
        query: "SELECT * FROM c WHERE c.studentEmail = @studentEmail",
        parameters: [{ name: "@studentEmail", value: studentEmail }]
    };

    try {
        const { resources: classes } = await classesContainer.items.query(querySpecClasses).fetchAll();
        const { resources: results } = await completedContentContainer.items.query(querySpecResults).fetchAll();

        let todo = [], pending = [], completed = [];
        const resultMap = new Map(results.map(r => [r.contentId, r]));

        classes.forEach(cls => {
            (cls.content || []).forEach(content => {
                const result = resultMap.get(content.id);
                const assignment = { ...content, className: cls.className, classId: cls.id, teacherEmail: cls.teacherEmail };
                
                if (!result) {
                    todo.push(assignment);
                } else if (result.status === 'pending_validation') {
                    pending.push({ ...assignment, ...result, completedAt: result.submittedAt });
                } else if (result.status === 'validated') {
                    completed.push({ ...assignment, ...result, completedAt: result.submittedAt });
                }
            });
        });

        res.json({ todo, pending, completed });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération du dashboard élève." });
    }
});

app.post('/api/student/submit-quiz', async (req, res) => {
    if (!classesContainer || !completedContentContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers, helpUsed, teacherEmail } = req.body;
    
    let status = 'pending_validation';
    let appreciation = null;
    let teacherComment = null;

    try {
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        const content = classData.content.find(c => c.id === contentId);
        if (content && content.type === 'quiz') {
            status = 'validated';
            appreciation = 'acquis';
            teacherComment = 'Quiz complété automatiquement.';
        }

        const newResult = {
            id: `${studentEmail}-${contentId}`,
            studentEmail,
            contentId,
            title,
            score,
            totalQuestions,
            answers,
            helpUsed,
            submittedAt: new Date().toISOString(),
            status: status,
            appreciation: appreciation,
            teacherComment: teacherComment
        };

        // 1. Sauvegarder dans CompletedContent
        await completedContentContainer.items.upsert(newResult);

        // 2. Mettre à jour le tableau 'results' de la classe
        const resultIndex = classData.results.findIndex(r => r.studentEmail === studentEmail && r.contentId === contentId);
        if (resultIndex > -1) {
            classData.results[resultIndex] = newResult;
        } else {
            classData.results.push(newResult);
        }
        await classesContainer.item(classId, teacherEmail).replace(classData);

        res.status(201).json(newResult);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la soumission du quiz." });
    }
});

// --- BIBLIOTHÈQUE (Éducation) ---
app.get('/api/library', async (req, res) => {
    // Logique de bibliothèque à implémenter
    res.json([]);
});

app.post('/api/library/publish', async (req, res) => {
    // Logique de bibliothèque à implémenter
    res.json({ message: "Contenu publié (simulation)." });
});


// =======================================================================
// === SERVICES IA (Partagés) ============================================
// =======================================================================

// --- IA : CHAT & GÉNÉRATION ---

// ▼▼▼ MODIFICATION 2 : ROUTE PLAYGROUND-CHAT MISE À JOUR (AIGUILLAGE) ▼▼▼
app.post('/api/ai/playground-chat', async (req, res) => {
    const { history, preferredAgent } = req.body;
    
    // 1. Préparer le prompt (inchangé)
    const prompt = history.map(m => `${m.role}: ${m.content}`).join('\n') + "\nassistant:";
    
    // 2. Logique d'aiguillage
    let clientToUse;
    let agentName;
    let modelName;

    if (preferredAgent === 'kimi') {
        clientToUse = aiApiKimi;
        agentName = 'Kimi-K2';
        modelName = "kimi-k2"; // (Adaptez ce nom de modèle si nécessaire)
    } else {
        clientToUse = aiApiDeepseek; // Deepseek est le défaut
        agentName = 'Deepseek';
        modelName = "deepseek-chat"; // (Adaptez ce nom de modèle si nécessaire)
    }

    try {
        // 3. Appel de l'IA sélectionnée
        console.log(`Appel de l'IA ${agentName}...`);
        const response = await clientToUse.post('', { // L'endpoint est déjà dans le baseURL
             model: modelName,
             messages: [{ role: "user", content: prompt }], // Format 'messages'
             max_tokens: 500
        });
        
        // 4. Renvoyer la réponse
        res.json({ 
            reply: response.data.choices[0].message.content, 
            agent: agentName 
        });

    } catch(e) {
        console.error(`Erreur API IA (${agentName}):`, e.message);
        res.status(500).json({error: `Erreur de l'API ${agentName}`});
    }
});
// ▲▲▲ FIN MODIFICATION 2 ▲▲▲

// ▼▼▼ MODIFICATION 3 : ROUTE GENERATE-FROM-UPLOAD MISE À JOUR (force Kimi) ▼▼▼
app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!formRecognizerClient || !blobContainerClient) { 
        return res.status(503).json({ error: "Service d'analyse de document non prêt." }); 
    }
    const { contentType, exerciseCount, language } = req.body;
    if (!req.file) return res.status(400).json({ error: "Aucun document reçu." });

    try {
        const file = req.file;
        const blobName = `${Date.now()}-gen-${file.originalname}`;
        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(file.buffer);
        const fileUrl = blockBlobClient.url;

        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-read", fileUrl);
        const { content } = await poller.pollUntilDone();

        const prompt = `
            Voici le contenu d'un document:
            ---
            ${content}
            ---
            Crée un ${contentType} de ${exerciseCount} questions basé sur ce texte.
            Langue: ${language}.
            Réponds en JSON structuré.
        `;
        
        // AIGUILLAGE : Forcer Kimi pour cette tâche
        console.log("Appel de Kimi pour la génération depuis document...");
        const response = await aiApiKimi.post('', {
            model: "kimi-k2", // (Adaptez le nom du modèle)
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 2048
        });

        res.json({ structured_content: JSON.parse(response.data.choices[0].message.content) });

    } catch (error) {
        console.error("Erreur lors de la génération depuis document (Kimi):", error.message);
        res.status(500).json({ error: error.message });
    }
});
// ▲▲▲ FIN MODIFICATION 3 ▲▲▲


app.post('/api/ai/generate-lesson-plan', async (req, res) => {
    // (Cette route utilise Deepseek par défaut)
    const { theme, level, numSessions, lang } = req.body;
    const prompt = `Crée un plan de leçon sur le thème "${theme}" pour un niveau ${level} en ${numSessions} sessions. Langue: ${lang}. Réponds en JSON structuré.`;
    
    // NOTE: L'objet JSON 'fakeStructuredPlan' de 130 lignes a été retiré.
    // Nous appelons l'IA.
    
    try {
        console.log("Appel de Deepseek pour la génération de plan...");
        const response = await aiApiDeepseek.post('', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            max_tokens: 2048
        });
        res.json({ structured_plan: JSON.parse(response.data.choices[0].message.content) });
    } catch(e) {
        console.error("Erreur IA (Deepseek - Plan):", e.message);
        res.status(500).json({error: "Erreur IA (Deepseek) " + e.message});
    }
});

// --- IA : PLAYGROUND UPLOAD (Extraction) ---
app.post('/api/ai/playground-extract-text', upload.single('document'), async (req, res) => {
    if (!formRecognizerClient || !blobContainerClient) { 
        return res.status(503).json({ error: "Service d'analyse de document non prêt." }); 
    }
    if (!req.file) return res.status(400).json({ error: "Aucun document reçu." });
    
    try {
        const file = req.file;
        const blobName = `${Date.now()}-extract-${file.originalname}`;
        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.uploadData(file.buffer);
        const fileUrl = blockBlobClient.url;

        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-read", fileUrl);
        const { content } = await poller.pollUntilDone();

        res.json({ extractedText: content });
    } catch (error) {
        console.error("Erreur lors de l'extraction de texte:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- IA : AIDE (Éducation) ---
app.post('/api/ai/get-aida-help', async (req, res) => {
    // (Cette route utilise Deepseek par défaut)
    const { history } = req.body;
    const prompt = history.map(m => `${m.role}: ${m.content}`).join('\n') + "\nassistant:";

    try {
        console.log("Appel de Deepseek pour Aida-Help...");
        const response = await aiApiDeepseek.post('', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 500
        });
        res.json({ response: response.data.choices[0].message.content });
    } catch (e) {
        console.error("Erreur IA (Deepseek - Help):", e.message);
        res.status(500).json({ error: "Erreur IA (Deepseek) " + e.message });
    }
});

// =======================================================================
// === ACADEMY MRE : ROUTES API ==========================================
// =======================================================================

// --- AUTHENTIFICATION (Académie) ---
app.post('/api/academy/auth/login', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        if (user && user.password === password) {
            const { password: _, ...userToReturn } = user;
            res.json({ user: userToReturn });
        } else {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        }
    } catch (error) {
        if (error.code === 404) {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        } else {
            res.status(500).json({ error: "Erreur serveur lors de la connexion." });
        }
    }
});

app.post('/api/academy/auth/signup', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { email, password, role } = req.body;
    
    if (!role.startsWith('academy_')) {
        return res.status(400).json({ error: "Rôle invalide pour l'inscription à l'académie." });
    }
    
    const newUser = {
        id: email,
        email,
        password: password,
        role,
        firstName: email.split('@')[0],
        lastName: "",
        avatar: `default_${Math.ceil(Math.random() * 8)}.png`,
        dailyStreak: { count: 0, lastLogin: null },
        achievements: [],
        academyProgress: {
            sessions: [],
            badges: []
        }
    };
    try {
        const { resource: createdUser } = await usersContainer.items.create(newUser);
        const { password: _, ...userToReturn } = createdUser;
        res.status(201).json({ user: userToReturn });
    } catch (error) {
        if (error.code === 409) {
            res.status(409).json({ error: "Un utilisateur avec cet email existe déjà." });
        } else {
            res.status(500).json({ error: "Erreur lors de la création du compte." });
        }
    }
});

// --- ACADEMY MRE : CHAT & VOIX ---
app.post('/api/academy/ai/chat', async (req, res) => {
    // (Cette route utilise Deepseek par défaut)
    const { history, response_format } = req.body;
    const prompt = history.map(m => `${m.role}: ${m.content}`).join('\n') + "\nassistant:";
    const isJson = response_format && response_format.type === 'json_object';

    try {
        console.log("Appel de Deepseek pour Academy-Chat...");
        const response = await aiApiDeepseek.post('', {
            model: "deepseek-chat",
            messages: [{ role: "user", content: prompt }],
            response_format: isJson ? { type: "json_object" } : undefined,
            max_tokens: 2048
        });
        res.json({ reply: response.data.choices[0].message.content });
    } catch(e) {
        console.error("Erreur IA (Deepseek - Academy):", e.message);
        res.status(500).json({error: "Erreur IA (Deepseek) " + e.message});
    }
});

// ▼▼▼ MODIFICATION 4 : CORRECTION BUG VOIX (EMOJI) ▼▼▼
app.post('/api/ai/synthesize-speech', async (req, res) => {
    if (!ttsClient) { return res.status(500).json({ error: "Le service de synthèse vocale n'est pas configuré sur le serveur." }); }
    const { text, voice, rate, pitch } = req.body;
    if (!text) return res.status(400).json({ error: "Le texte est manquant." });

    // Nettoyage du texte pour supprimer les emojis et markdown
    const cleanedText = text
        .replace(/([\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}])/gu, '') // Supprime les emojis
        .replace(/[*#_`]/g, ''); // Supprime les marqueurs markdown

    const request = { 
        input: { text: cleanedText }, // Utilise le texte nettoyé
        voice: { 
            languageCode: voice ? voice.substring(0, 5) : 'fr-FR', 
            name: voice || 'fr-FR-Wavenet-E' 
        }, 
        audioConfig: { 
            audioEncoding: 'MP3', 
            speakingRate: parseFloat(rate) || 1.0, 
            pitch: parseFloat(pitch) || 0.0, 
        }, 
    };
    try {
        const [response] = await ttsClient.synthesizeSpeech(request);
        const audioContent = response.audioContent.toString('base64');
        res.json({ audioContent });
    } catch (error) {
        console.error("Erreur lors de la synthèse vocale Google:", error);
        res.status(500).json({ error: "Impossible de générer l'audio." });
    }
});
// ▲▲▲ FIN MODIFICATION 4 ▲▲▲

// --- ACADEMY MRE : PROGRESSION & GAMIFICATION ---
app.post('/api/academy/achievement/unlock', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { userId, badgeId } = req.body;
    try {
        const { resource: user } = await usersContainer.item(userId, userId).read();
        if (!user.achievements) user.achievements = [];
        if (!user.achievements.includes(badgeId)) {
            user.achievements.push(badgeId);
            await usersContainer.item(userId, userId).replace(user);
        }
        const { password: _, ...userToReturn } = user;
        res.json({ user: userToReturn });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors du déblocage du badge." });
    }
});

app.post('/api/academy/session/save', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { userId, scenarioId, report, fullHistory } = req.body;
    try {
        const { resource: user } = await usersContainer.item(userId, userId).read();
        if (!user.academyProgress) user.academyProgress = { sessions: [], badges: [] };
        if (!user.academyProgress.sessions) user.academyProgress.sessions = [];
        
        user.academyProgress.sessions.push({
            id: scenarioId,
            completedAt: new Date().toISOString(),
            report: report,
            history: fullHistory
        });
        
        await usersContainer.item(userId, userId).replace(user);
        res.status(200).json({ message: "Session sauvegardée." });
    } catch (error) {
        console.error("Erreur lors de la sauvegarde de la session:", error.message);
        res.status(500).json({ error: "Erreur serveur lors de la sauvegarde." });
    }
});

// --- ACADEMY MRE : ROUTES ENSEIGNANT ---
app.get('/api/academy/scenarios', async (req, res) => {
    if (!scenariosContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    try {
        const { resources: scenarios } = await scenariosContainer.items.query("SELECT * FROM c").fetchAll();
        res.json(scenarios);
    } catch (error) {
        console.error("Erreur lors de la récupération des scénarios:", error.message);
        res.status(500).json({ error: "Erreur serveur." });
    }
});

app.post('/api/academy/scenarios/create', async (req, res) => {
    if (!scenariosContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const scenarioData = req.body;
    
    // Simulé: dans une vraie app, on prendrait le teacherEmail du token JWT
    const simulatedTeacherEmail = "enseignant.demo@aida.com";

    const newScenario = {
        ...scenarioData,
        id: `scen-${Date.now()}`,
        teacherEmail: simulatedTeacherEmail // Clé de partition
    };

    try {
        const { resource: createdScenario } = await scenariosContainer.items.create(newScenario);
        console.log(`Scénario créé: ${createdScenario.id}`);
        res.status(201).json({ message: "Scénario créé avec succès.", scenario: createdScenario });
    } catch (error) {
        console.error("Erreur lors de la création du scénario dans la DB:", error.message);
        res.status(500).json({ error: "Erreur serveur lors de la création du scénario." });
    }
});

app.get('/api/academy/teacher/students', async (req, res) => {
    if (!usersContainer) { 
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { teacherEmail } = req.query;
    const querySpec = {
        query: "SELECT c.id, c.firstName, c.academyProgress FROM c WHERE c.role = @role",
        parameters: [
            { name: "@role", value: "academy_student" }
        ]
    };
    try {
        const { resources: students } = await usersContainer.items.query(querySpec).fetchAll();
        res.json(students);
    } catch (error) {
        console.error("Erreur lors de la récupération des élèves de l'académie:", error.message);
        res.status(500).json({ error: "Erreur serveur lors de la récupération des élèves." });
    }
});

// ▼▼▼ MODIFICATION 5 : ROUTE GRADE-UPLOAD MISE À JOUR (force Kimi) ▼▼▼
app.post('/api/ai/grade-upload', upload.array('copies'), async (req, res) => {
    if (!formRecognizerClient || !blobContainerClient) { 
        return res.status(503).json({ error: "Service d'analyse de document non prêt." }); 
    }
    const { sujet, criteres, lang } = req.body;
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "Aucun fichier reçu." });
    }
    
    try {
        const file = req.files[0];
        const blobName = `${Date.now()}-${file.originalname}`;
        const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadData(file.buffer);
        const fileUrl = blockBlobClient.url;
        
        console.log(`Fichier uploadé sur Blob Storage: ${fileUrl}`);

        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-read", fileUrl);
        const { content } = await poller.pollUntilDone();
        
        console.log("Texte extrait par Form Recognizer.");

        const gradingPrompt = `
            Tu es un assistant professeur. Analyse la copie suivante basée sur le sujet et les critères.
            Sujet: ${sujet}
            Critères: ${criteres}
            ---
            Contenu de la copie extraite:
            ${content}
            ---
            Fournis une évaluation en JSON structuré (langue: ${lang}) avec les clés: "noteFinale", "analyseGlobale", "commentaireEleve", et "criteres" (un tableau d'objets {nom, note, commentaire}).
        `;
        
        // AIGUILLAGE : Forcer Kimi pour cette tâche
        console.log("Appel de Kimi pour l'analyse de la copie...");
        const response = await aiApiKimi.post('', {
            model: "kimi-k2", // (Adaptez le nom du modèle)
            messages: [{ role: "user", content: gradingPrompt }],
            response_format: { type: "json_object" },
            max_tokens: 2048
        });

        const analysis = JSON.parse(response.data.choices[0].message.content);
        res.json(analysis);

    } catch (error) {
        console.error("Erreur lors de l'analyse de la copie:", error);
        res.status(500).json({ error: error.message });
    }
});
// ▲▲▲ FIN MODIFICATION 5 ▲▲▲


// --- Point d'entrée et démarrage du serveur ---
const PORT = process.env.PORT || 3000;

// ▼▼▼ MODIFICATION 6 : DÉMARRAGE ROBUSTE ▼▼▼
// (Attend que la DB soit initialisée AVANT de démarrer le serveur)
initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server AIDA démarré sur le port ${PORT}`);
    });
}).catch(err => {
    console.error("Échec de l'initialisation de la base de données, le serveur ne démarrera pas.", err);
    process.exit(1);
});
// ▲▲▲ FIN MODIFICATION 6 ▲▲▲