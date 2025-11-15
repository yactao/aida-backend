// =======================================================================
// === AÏDA BACKEND - SERVEUR PRINCIPAL (server.js) ======================
// =======================================================================

// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DocumentAnalysisClient, AzureKeyCredential } = require("@azure/ai-form-recognizer");
const multer = require('multer');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// --- 2. Initialisation Globale ---
const app = express();

// Configuration des clients de services (seront initialisés au démarrage)
let dbClient, database, usersContainer, classesContainer, completedContentContainer, scenariosContainer;
let blobServiceClient, blobContainerClient;
let formRecognizerClient, ttsClient, aiApi;

// Configuration de Multer (pour l'upload de fichiers en mémoire)
const upload = multer({ storage: multer.memoryStorage() });

// --- 3. Connexion aux Services (Démarrage) ---

/**
 * Initialise tous les clients de services externes (Azure, Google, OpenAI).
 * Le serveur ne démarrera pas si ces connexions échouent.
 */
async function initializeServices() {
    console.log("Initialisation des services...");
    try {
        // 3.1. Azure Cosmos DB
        if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) throw new Error("Variables Cosmos DB manquantes.");
        dbClient = new CosmosClient({
            endpoint: process.env.COSMOS_ENDPOINT,
            key: process.env.COSMOS_KEY
        });
        const { database: db } = await dbClient.databases.createIfNotExists({ id: "AidaDB" });
        database = db;
        
        // Conteneurs
        const { container: usersCont } = await database.containers.createIfNotExists({ id: "Users", partitionKey: { paths: ["/email"] } });
        usersContainer = usersCont;
        const { container: classesCont } = await database.containers.createIfNotExists({ id: "Classes", partitionKey: { paths: ["/teacherEmail"] } });
        classesContainer = classesCont;
        const { container: completedCont } = await database.containers.createIfNotExists({ id: "CompletedContent", partitionKey: { paths: ["/studentEmail"] } });
        completedContentContainer = completedCont;
        const { container: scenariosCont } = await database.containers.createIfNotExists({ id: "AcademyScenarios", partitionKey: { paths: ["/teacherEmail"] } });
        scenariosContainer = scenariosCont;
        
        console.log("✅ Cosmos DB connecté.");

        // 3.2. Azure Blob Storage
        if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error("Variable Azure Storage manquante.");
        blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        blobContainerClient = blobServiceClient.getContainerClient("graded-copies");
        await blobContainerClient.createIfNotExists();
        console.log("✅ Azure Blob Storage connecté.");

        // 3.3. Azure Form Recognizer
        if (!process.env.FORM_RECOGNIZER_ENDPOINT || !process.env.FORM_RECOGNIZER_KEY) throw new Error("Variables Form Recognizer manquantes.");
        formRecognizerClient = new DocumentAnalysisClient(
            process.env.FORM_RECOGNIZER_ENDPOINT,
            new AzureKeyCredential(process.env.FORM_RECOGNIZER_KEY)
        );
        console.log("✅ Azure Form Recognizer connecté.");

        // 3.4. Google Text-to-Speech
        if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) throw new Error("Variable Google TTS manquante.");
        ttsClient = new TextToSpeechClient();
        console.log("✅ Google TTS connecté.");

        // 3.5. Client IA (OpenAI / Azure OpenAI)
        if (!process.env.OPENAI_API_ENDPOINT || !process.env.OPENAI_API_KEY) throw new Error("Variables OpenAI (ENDPOINT ou KEY) manquantes.");
        aiApi = axios.create({
            baseURL: process.env.OPENAI_API_ENDPOINT,
            headers: { 'api-key': process.env.OPENAI_API_KEY } // ou 'Authorization': `Bearer ${...}`
        });
        console.log("✅ Client IA (OpenAI) configuré.");


        console.log("--- Tous les services sont initialisés avec succès. ---");
        return true;

    } catch (error) {
        console.error("❌ ERREUR CRITIQUE PENDANT L'INITIALISATION:", error.message);
        process.exit(1); // Arrête l'application si les services ne démarrent pas
    }
}

// --- 4. Middleware Express ---

// Configuration CORS
const allowedOrigins = [
    'https://gray-meadow-0061b3603.1.azurestaticapps.net',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`Origine non autorisée bloquée par CORS: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

// Middleware pour parser le JSON et servir les fichiers statiques
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware simple pour vérifier la disponibilité de la DB
app.use((req, res, next) => {
    if (!database) {
        return res.status(503).json({ error: "Service de base de données non initialisé." });
    }
    next();
});

// =======================================================================
// === 5. Routes API: Authentification (Fusionnée) =======================
// =======================================================================

// Routes fusionnées pour AIDA Éducation et AIDA Académie
app.post('/api/auth/login', async (req, res) => {
    const { email, password, platform } = req.body; // platform: 'education' or 'academy'
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        
        if (!user || user.password !== password) {
            return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        }
        
        const isAcademyUser = user.role.startsWith('academy_');
        
        // Vérification de la plateforme
        if (platform === 'academy' && !isAcademyUser) {
            return res.status(403).json({ error: "Ce compte n'est pas un compte Académie." });
        }
        if (platform === 'education' && isAcademyUser) {
            return res.status(403).json({ error: "Ce compte n'est pas un compte Éducation." });
        }

        const { password: _, ...userToReturn } = user;
        res.json({ user: userToReturn });
        
    } catch (error) {
        if (error.code === 404) {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        } else {
            res.status(500).json({ error: "Erreur serveur." });
        }
    }
});

app.post('/api/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    
    const newUser = {
        id: email,
        email,
        password, // Rappel: Envisagez bcrypt pour la production
        role,
        firstName: email.split('@')[0],
        lastName: "",
        avatar: `default_${Math.ceil(Math.random() * 8)}.png`
    };

    // Si c'est un compte académie, initialiser le progrès
    if (role.startsWith('academy_')) {
        newUser.academyProgress = {
            badges: [],
            sessions: [],
            streak: 0,
            lastLogin: null
        };
    }

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

// =======================================================================
// === 6. Routes API: AIDA Éducation =====================================
// =======================================================================
// (Logique copiée de votre fichier server.js original)

app.get('/api/teacher/classes', async (req, res) => {
    const { teacherEmail } = req.query;
    const querySpec = {
        query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail",
        parameters: [{ name: "@teacherEmail", value: teacherEmail }]
    };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.json(classes);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des classes." });
    }
});

app.post('/api/teacher/classes', async (req, res) => {
    const { className, teacherEmail } = req.body;
    const newClass = {
        className,
        teacherEmail,
        students: [],
        content: [],
        results: [],
        id: `class-${Date.now()}`
    };
    try {
        const { resource: createdClass } = await classesContainer.items.create(newClass);
        res.status(201).json(createdClass);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la création de la classe." });
    }
});

app.get('/api/teacher/classes/:id', async (req, res) => {
    const { id } = req.params;
    const { teacherEmail } = req.query;
    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        
        if (classData && classData.students.length > 0) {
            const studentEmails = classData.students;
            const querySpec = {
                query: `SELECT c.email, c.firstName, c.lastName, c.avatar FROM c WHERE ARRAY_CONTAINS(@studentEmails, c.email)`,
                parameters: [{ name: '@studentEmails', value: studentEmails }]
            };
            const { resources: studentsWithDetails } = await usersContainer.items.query(querySpec).fetchAll();
            classData.studentsWithDetails = studentsWithDetails;
        } else {
            classData.studentsWithDetails = [];
        }
        res.json(classData);
    } catch (error) {
        if (error.code === 404) res.status(404).json({ error: "Classe non trouvée." });
        else res.status(500).json({ error: "Erreur serveur." });
    }
});

app.post('/api/teacher/classes/:id/add-student', async (req, res) => {
    const { id } = req.params;
    const { studentEmail, teacherEmail } = req.body;
    try {
        const { resource: classData } = await classesContainer.item(id, teacherEmail).read();
        if (!classData.students.includes(studentEmail)) {
            classData.students.push(studentEmail);
            await classesContainer.item(id, teacherEmail).replace(classData);
        }
        res.json(classData);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de l'ajout de l'élève." });
    }
});

// ... (Toutes les autres routes /api/teacher/... de votre fichier original iraient ici) ...

app.get('/api/student/dashboard', async (req, res) => {
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
            cls.content.forEach(content => {
                const result = resultMap.get(content.id);
                const assignment = { ...content, className: cls.className, classId: cls.id, teacherEmail: cls.teacherEmail };
                
                if (!result) todo.push(assignment);
                else if (result.status === 'pending_validation') pending.push({ ...assignment, ...result });
                else if (result.status === 'validated') completed.push({ ...assignment, ...result });
            });
        });
        res.json({ todo, pending, completed });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération du dashboard élève." });
    }
});

app.post('/api/student/submit-quiz', async (req, res) => {
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers, helpUsed, teacherEmail } = req.body;
    
    let status = 'pending_validation';
    try {
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        const content = classData.content.find(c => c.id === contentId);
        if (content && content.type === 'quiz') status = 'validated';
    } catch(e) { /* Gérer l'erreur */ }

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
        appreciation: (status === 'validated' ? 'acquis' : null),
        teacherComment: (status === 'validated' ? 'Quiz complété automatiquement.' : null)
    };
    try {
        await completedContentContainer.items.upsert(newResult);
        res.status(201).json(newResult);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la soumission du quiz." });
    }
});

// =======================================================================
// === 7. Routes API: AIDA Académie ======================================
// =======================================================================
// (Logique copiée de votre fichier server.js original)

app.post('/api/academy/session/save', async (req, res) => {
    const { userId, scenarioId, report, fullHistory } = req.body;
    try {
        const { resource: student } = await usersContainer.item(userId, userId).read();
        if (!student) return res.status(404).json({ error: "Élève non trouvé." });

        if (!student.academyProgress) student.academyProgress = { sessions: [], badges: [] };
        
        student.academyProgress.sessions.push({
            id: scenarioId,
            completedAt: new Date().toISOString(),
            report: report,
            history: fullHistory // Sauvegarde de l'historique
        });
        
        await usersContainer.item(userId, userId).replace(student);
        res.status(200).json({ message: "Progrès sauvegardé." });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la sauvegarde du progrès." });
    }
});

app.post('/api/academy/achievement/unlock', async (req, res) => {
    const { userId, badgeId } = req.body;
    try {
        const { resource: student } = await usersContainer.item(userId, userId).read();
        if (!student) return res.status(404).json({ error: "Élève non trouvé." });

        if (!student.academyProgress) student.academyProgress = { sessions: [], badges: [] };
        if (!student.academyProgress.badges.includes(badgeId)) {
            student.academyProgress.badges.push(badgeId);
            await usersContainer.item(userId, userId).replace(student);
        }
        
        const { password: _, ...userToReturn } = student;
        res.status(200).json({ message: "Badge débloqué.", user: userToReturn });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors du déblocage du badge." });
    }
});

app.get('/api/academy/scenarios', async (req, res) => {
    // Dans un vrai scénario, filtrer par teacherEmail ou scénarios "publics"
    try {
        const { resources: scenarios } = await scenariosContainer.items.query("SELECT * FROM c").fetchAll();
        res.json(scenarios);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des scénarios." });
    }
});

app.post('/api/academy/scenarios/create', async (req, res) => {
    const scenarioData = req.body;
    const newScenario = {
        ...scenarioData,
        id: `scen-${Date.now()}`,
        teacherEmail: window.currentUser.email // Assurez-vous que currentUser est disponible ou passé
    };
    try {
        const { resource: createdScenario } = await scenariosContainer.items.create(newScenario);
        res.status(201).json({ message: "Scénario créé.", scenario: createdScenario });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la création du scénario." });
    }
});

app.get('/api/academy/teacher/students', async (req, res) => {
    const querySpec = {
        query: "SELECT c.id, c.email, c.firstName, c.lastName, c.avatar, c.academyProgress FROM c WHERE c.role = @role",
        parameters: [{ name: "@role", value: "academy_student" }]
    };
    try {
        const { resources: students } = await usersContainer.items.query(querySpec).fetchAll();
        res.json(students);
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la récupération des élèves." });
    }
});

// ▼▼▼ NOUVELLE ROUTE (Pagination) AJOUTÉE ▼▼▼
app.get('/api/academy/student/:id/sessions', async (req, res) => {
    try {
        const { id } = req.params;
        const studentEmail = id;
        const page = parseInt(req.query.page || 1, 10);
        const limit = parseInt(req.query.limit || 10, 10);
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();

        if (!student || !student.academyProgress || !student.academyProgress.sessions) {
            return res.json({ sessions: [], totalPages: 0, totalSessions: 0, currentPage: page });
        }

        const allSessions = student.academyProgress.sessions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
        const paginatedSessions = allSessions.slice(startIndex, endIndex);
        const totalSessions = allSessions.length;
        const totalPages = Math.ceil(totalSessions / limit);

        res.json({
            sessions: paginatedSessions,
            totalPages: totalPages,
            totalSessions: totalSessions,
            currentPage: page
        });

    } catch (error) {
        if (error.code === 404) return res.status(404).json({ error: "Élève non trouvé." });
        res.status(500).json({ error: "Erreur serveur." });
    }
});

// =======================================================================
// === 8. Routes API: Services IA Partagés ===============================
// =======================================================================
// (Logique copiée de votre fichier server.js original)

app.post('/api/ai/playground-chat', async (req, res) => {
    try {
        const prompt = req.body.history.map(m => `${m.role}: ${m.content}`).join('\n') + "\nassistant:";
        const response = await aiApi.post('/completions', { // ou votre déploiement
             prompt: prompt,
             max_tokens: 500
        });
        res.json({ reply: response.data.choices[0].text, agent: "Aïda-deep" });
    } catch(e) {
        res.status(500).json({error: "Erreur de l'API IA"});
    }
});

app.post('/api/ai/generate-content', async (req, res) => {
    try {
        const { competences, contentType, exerciseCount, language } = req.body;
        const prompt = `Génère-moi ${exerciseCount} questions pour un ${contentType} de niveau ${language} sur la compétence: "${competences}". Réponds en JSON.`;
        
        // const response = await aiApi.post('/completions', { prompt, max_tokens: 1000 });
        // const realJson = JSON.parse(response.data.choices[0].text);
        
        // Simulation car l'objet JSON a été retiré de ce fichier
        const fakeResponse = {
            title: `Quiz simulé sur: ${competences}`,
            type: contentType,
            questions: [
                { question_text: "Question 1 (simulée)", options: ["Oui", "Non"], correct_answer_index: 0 },
                { question_text: "Question 2 (simulée)", options: ["Vrai", "Faux"], correct_answer_index: 0 }
            ]
        };
        res.json({ structured_content: fakeResponse });
        
    } catch(e) {
        res.status(500).json({error: "Erreur de l'API IA"});
    }
});

// ROUTE AVEC LE JSON GÉANT RETIRÉ
app.post('/api/ai/generate-lesson-plan', async (req, res) => {
    // const { selectedCompetenceInfo, studentLevel, studentProfile } = req.body;
    // const prompt = `...`;
    
    // L'immense objet 'fakeStructuredPlan' (130+ lignes) a été retiré.
    // Nous simulons la réponse que l'IA aurait donnée.
    const simulation = {
        title: "Simulation de Plan de Leçon",
        introduction: "Ceci est une introduction simulée.",
        steps: [
            { title: "Étape 1", content: "Contenu de l'étape 1." },
            { title: "Étape 2", content: "Contenu de l'étape 2." }
        ],
        conclusion: "Ceci est une conclusion simulée."
    };
    
    res.json({ structured_plan: simulation });
});

app.post('/api/ai/synthesize-speech', async (req, res) => {
    try {
        const { text, voice, rate, pitch } = req.body;
        const request = {
            input: { text: text },
            voice: { 
                languageCode: voice ? voice.substring(0, 5) : 'fr-FR', 
                name: voice || 'fr-FR-Wavenet-E'
            },
            audioConfig: { 
                audioEncoding: 'MP3',
                speakingRate: parseFloat(rate || 1.0),
                pitch: parseFloat(pitch || 1.0)
            },
        };
        const [response] = await ttsClient.synthesizeSpeech(request);
        res.json({ audioContent: response.audioContent.toString('base64') });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la synthèse vocale." });
    }
});

app.post('/api/ai/grade-upload', upload.array('copies'), async (req, res) => {
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
        
        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-read", fileUrl);
        const { content } = await poller.pollUntilDone();
        
        const gradingPrompt = `... (Votre prompt pour la notation va ici) ...`;
        
        // Simulation de la réponse de l'IA
        const analysis = {
            noteFinale: "15/20",
            analyseGlobale: "Simulation : Très bon travail sur le fond.",
            commentaireEleve: "Simulation : Vous avez bien compris le sujet.",
            criteres: [ { nom: "Compréhension", note: "8/10", commentaire: "Simulé." } ]
        };
        res.json(analysis);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// =======================================================================
// === 9. Démarrage du Serveur ===========================================
// =======================================================================

const PORT = process.env.PORT || 3000;

// Démarrer les services AVANT d'écouter les requêtes
initializeServices().then((success) => {
    if (success) {
        app.listen(PORT, () => {
            console.log(`🚀 Serveur AIDA démarré sur le port ${PORT}`);
        });
    } else {
        console.error("❌ Échec du démarrage du serveur en raison d'erreurs d'initialisation.");
    }
});