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
const { GoogleGenerativeAI } = require("@google/generative-ai");

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

try {
    if (!process.env.COSMOS_ENDPOINT || !process.env.COSMOS_KEY) throw new Error("COSMOS_ENDPOINT ou COSMOS_KEY manquant.");
    dbClient = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    console.log("Client Cosmos DB initialisé.");
} catch(e) { console.error("ERREUR Cosmos DB:", e.message); }

try {
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) throw new Error("AZURE_STORAGE_CONNECTION_STRING manquant.");
    blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    console.log("Client Blob Storage initialisé.");
} catch(e) { console.error("ERREUR Blob Storage:", e.message); }

try {
    if (!process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || !process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY) throw new Error("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ou AZURE_DOCUMENT_INTELLIGENCE_KEY manquant.");
    formRecognizerClient = new DocumentAnalysisClient(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY));
    console.log("Client Document Intelligence initialisé.");
} catch(e) { console.error("ERREUR Document Intelligence:", e.message); }

try {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) throw new Error("Variable d'environnement GOOGLE_APPLICATION_CREDENTIALS_JSON non trouvée.");
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    ttsClient = new TextToSpeechClient({ credentials });
    console.log("Client Google Cloud Text-to-Speech prêt (via JSON).");
} catch(e) {
    console.warn("AVERTISSEMENT Google Cloud TTS:", e.message);
    ttsClient = null;
}

const database = dbClient?.database('AidaDB');
let usersContainer;
let classesContainer;
let libraryContainer;
let scenariosContainer;

// --- FONCTIONS ET DONNÉES PAR DÉFAUT ---
const defaultScenarios = [
    { 
        id: 'scen-0', 
        title: "Scénario 0 : Répétiteur Vocal (Phrases de Base)", 
        language: "Arabe Littéraire (Al-Fusha)", 
        level: "Débutant Absolu", 
        context: "L'IA joue le rôle d'un tuteur amical et patient...", 
        characterName: "Le Répétiteur (المُعِيد)", 
        characterIntro: "أهلاً بك! هيا نتدرب على النطق. كرر هذه الجملة: أنا بخير. <PHONETIQUE>Ahlan bik! Hayyā natadarab 'alā an-nuṭq. Karrir hādhihi al-jumla: Anā bi-khayr.</PHONETIQUE> <TRADUCTION>Bienvenue ! Entraînons-nous à la prononciation. Répète cette phrase : Je vais bien.</TRADUCTION>", 
        objectives: ["Répéter correctement 'Je vais bien'.", "Répéter correctement 'Merci'.", "Répéter correctement 'Quel est votre nom?'."],
        voiceCode: 'ar-XA-Wavenet-B'
    },
    { 
        id: 'scen-1', 
        title: "Scénario 1 : Commander son petit-déjeuner", 
        language: "Arabe Littéraire (Al-Fusha)", 
        level: "Débutant", 
        context: "Vous entrez dans un café moderne au Caire...", 
        characterName: "Le Serveur (النادِل)", 
        characterIntro: "صباح الخير، تفضل. ماذا تود أن تطلب اليوم؟ <PHONETIQUE>Sabah al-khayr, tafaddal. Mādhā tawaddu an taṭlub al-yawm?</PHONETIQUE> <TRADUCTION>Bonjour, entrez. Que souhaitez-vous commander aujourd'hui ?</TRADUCTION>", 
        objectives: ["Demander un thé et un croissant.", "Comprendre le prix total.", "Dire 'Merci' et 'Au revoir'."],
        voiceCode: 'ar-XA-Wavenet-B'
    }
];

// --- INITIALISATION DE LA BASE DE DONNÉES ---
async function initializeDatabase() {
    if (!dbClient || !database) return console.error("Base de données non initialisée. Les routes DB seront indisponibles.");
    try {
        let result;
        result = await database.containers.createIfNotExists({ id: 'Users', partitionKey: '/id' });
        usersContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Classes', partitionKey: '/teacherEmail' });
        classesContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Library', partitionKey: '/subject' });
        libraryContainer = result.container;
        result = await database.containers.createIfNotExists({ id: 'Scenarios', partitionKey: '/id' }); 
        scenariosContainer = result.container;
        console.log("Tous les conteneurs (Users, Classes, Library, Scenarios) sont initialisés.");
    } catch (error) {
        console.error("Erreur critique lors de l'initialisation des conteneurs de la DB:", error.message);
        throw error; 
    }
}
// ---------------------------------------------------------------------

app.get('/', (req, res) => {
    res.send('<h1>Serveur AIDA</h1><p>Le serveur est en ligne et fonctionne correctement.</p>');
});

//
// =========================================================================
// === ARCHITECTURE "AGENT-TO-AGENT" (POUR LE PLAYGROUND) ===
// =========================================================================
//

/**
 * AGENT 1 : Deepseek (Agent par Défaut)
 */
async function getDeepseekPlaygroundCompletion(history) {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
    const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
    
    if (!DEEPSEEK_API_KEY) {
        throw new Error("Clé API Deepseek non configurée.");
    }
    const endpoint = `${DEEPSEEK_BASE_URL}/v1/chat/completions`; 
    
    const deepseekHistory = [
        { role: "system", content: "Tu es AIDA, un tuteur IA bienveillant et pédagogue. Ton objectif est de guider les élèves vers la solution sans jamais donner la réponse directement, sauf en dernier recours. Tu dois adapter ton langage à l'âge de l'élève et suivre une méthode socratique : questionner d'abord, donner un indice ensuite, et valider la compréhension de l'élève." },
        ...history.filter(msg => msg.role !== 'system')
    ];

    try {
        const response = await axios.post(endpoint, {
            model: DEEPSEEK_MODEL,
            messages: deepseekHistory
        }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
        
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erreur lors de l'appel à l'API Deepseek:", error.response?.data || error.message);
        throw new Error("L'agent Deepseek n'a pas pu répondre.");
    }
}

/**
 * AGENT 2 : Kimi (Moonshot AI) (Agent Spécialiste)
 */
async function callKimiCompletion(history) {
    const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
    const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL; 
    const MOONSHOT_MODEL = process.env.MOONSHOT_MODEL;

    if (!MOONSHOT_API_KEY || !MOONSHOT_BASE_URL || !MOONSHOT_MODEL) {
        throw new Error("Clé API, URL de base ou Modèle Moonshot non configuré.");
    }
    
    // CORRECTION : Ajout de /v1
    const endpoint = `${MOONSHOT_BASE_URL}/chat/completions`;

    const kimiHistory = [
        { role: "system", content: "Tu es Kimi, un assistant IA spécialisé dans l'analyse de documents longs et complexes. Réponds en te basant sur les documents fournis dans l'historique. Sois concis et factuel." },
        ...history.filter(msg => msg.role !== 'system')
    ];

    try {
        const response = await axios.post(endpoint, {
            model: MOONSHOT_MODEL,
            messages: kimiHistory,
            temperature: 0.3,
        }, {
            headers: {
                'Authorization': `Bearer ${MOONSHOT_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Erreur lors de l'appel à l'API Moonshot:", error.response ? error.response.data : error.message);
        throw new Error("L'agent Kimi n'a pas pu répondre.");
    }
}

/**
 * AGENT 3 : Gemini (LearnLM) (Agent Spécialiste)
 */
// Fonction spécialisée pour Gemini (LearnLM)
async function callGeminiLearnLM(history) {
    // Initialisation
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GEN_AI_KEY);
    // Le modèle "Flash" est très rapide et excellent pour la logique/maths
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // On prépare l'historique pour Gemini
    // (Note: Gemini a un format d'historique spécifique, on simplifie ici pour l'intégration rapide)
    const lastMessage = history[history.length - 1].content;

    const systemPrompt = `Tu es AIDA, un tuteur expert en Mathématiques et Sciences.
    Si l'élève demande de dessiner une figure géométrique (triangle, cercle, courbe...), TU DOIS générer le code SVG correspondant.
    
    Règles pour le SVG :
    1. Le code doit commencer par <svg ...> et finir par </svg>.
    2. Utilise width="300" et height="300" par défaut.
    3. Utilise des traits noirs (stroke="black") et un fond transparent ou blanc (fill="none" ou fill="white").
    4. Ajoute des étiquettes (A, B, C...) avec la balise <text> si nécessaire.
    
    N'explique pas le code SVG, affiche-le simplement au milieu de ton explication.`;

    const chat = model.startChat({
        history: [
            {
                role: "user",
                parts: [{ text: systemPrompt }],
            },
        ],
    });

    try {
        const result = await chat.sendMessage(lastMessage);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Erreur Gemini:", error);
        throw new Error("Désolé, je n'ai pas pu générer la réponse visuelle.");
    }
}


// ROUTE PLAYGROUND CHAT (AGENT MANAGER)
app.post('/api/ai/playground-chat', async (req, res) => {
    const { history, preferredAgent } = req.body;

    if (!history || history.length === 0) {
        return res.status(400).json({ error: "L'historique est vide." });
    }

    try {
        let reply = "";
        let agentName = "";
        const lastUserMessage = history[history.length - 1].content;
        const lastUserMessageLow = lastUserMessage.toLowerCase();
        
        // --- LOGIQUE DU ROUTEUR AMÉLIORÉE (V3 - Avec Visuel) ---

        // 1. Définitions pour Kimi (Documents longs)
        const keywordsForKimi = ['kimi', 'analyse ce document', 'lis ce texte', 'résume'];
        const isLongText = lastUserMessage.length > 10000; 

        // 2. Définitions pour LearnLM/Gemini (Visuel & Géométrie)
        const keywordsForVisual = [
            'dessine', 'trace', 'figure', 'géométrie', 'triangle', 'cercle', 
            'carré', 'rectangle', 'schéma', 'svg', 'graphique', 'visuel'
        ];
        // On vérifie si un mot-clé visuel est présent
        const needsVisual = keywordsForVisual.some(keyword => lastUserMessageLow.includes(keyword));
        
        // --- ARBRE DE DÉCISION ---

        if (preferredAgent === 'kimi' || keywordsForKimi.some(k => lastUserMessageLow.includes(k)) || isLongText) {
            
            // PRIORITÉ 1 : Documents Longs -> Kimi
            console.log("Info: Routage vers l'Agent Kimi (Contexte Long)...");
            reply = await callKimiCompletion(history);
            agentName = "Aïda-Kimi"; 

        } else if (preferredAgent === 'gemini' || needsVisual) {

            // PRIORITÉ 2 : Demandes Visuelles/Maths -> Gemini (LearnLM)
            console.log("Info: Routage vers l'Agent Gemini (Spécialiste Visuel)...");
            // Appelle la fonction que nous avons créée à l'étape précédente
            reply = await callGeminiLearnLM(history); 
            agentName = "Aïda-Visuel";

        } else {
            
            // PRIORITÉ 3 : Conversation Standard -> Deepseek (Défaut)
            console.log("Info: Routage vers l'Agent Deepseek (Défaut)...");
            reply = await getDeepseekPlaygroundCompletion(history); 
            agentName = "Aïda-Deep";
        }
        
        res.json({ reply: reply, agent: agentName });

    } catch (error) {
        console.error("Erreur dans le routeur d'agent:", error);
        res.status(500).json({ error: error.message });
    }
});
// =========================================================================
// === FIN DE L'ARCHITECTURE "AGENT-TO-AGENT" ===
// =========================================================================
//


// --- API Routes (AIDA ÉDUCATION) ---
app.post('/api/auth/login', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        if (user && !user.role.startsWith('academy_') && user.password === password) { 
            delete user.password;
            res.json({ user });
        } else {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        }
    } catch (error) {
        if (error.code === 404) {
            res.status(401).json({ error: "Email ou mot de passe incorrect." });
        } else {
            res.status(500).json({ error: "Erreur du serveur." });
        }
    }
});
app.post('/api/auth/signup', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { email, password, role } = req.body;
    const newUser = { id: email, email, password, role, firstName: email.split('@')[0], avatar: 'default.png', classOrder: [] };
    try {
        const { resource: createdUser } = await usersContainer.items.create(newUser);
        delete createdUser.password;
        res.status(201).json({ user: createdUser });
    } catch (error) {
        if (error.code === 409) {
            res.status(409).json({ error: "Cet email est déjà utilisé." });
        } else {
            res.status(500).json({ error: "Erreur lors de la création du compte." });
        }
    }
});
// DANS server.js

// NOUVELLE ROUTE : Débloquer un badge (Achievement)
app.post('/api/academy/achievement/unlock', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    
    const { userId, badgeId } = req.body;
    if (!userId || !badgeId) {
        return res.status(400).json({ error: "userId et badgeId sont requis." });
    }

    try {
        const { resource: user } = await usersContainer.item(userId, userId).read();
        if (!user) {
            return res.status(404).json({ error: "Utilisateur non trouvé." });
        }

        user.achievements = user.achievements || [];
        
        if (user.achievements.includes(badgeId)) {
            // L'utilisateur a déjà ce badge
            delete user.password;
            return res.json({ message: "Badge déjà possédé.", user: user });
        }

        // Ajoute le nouveau badge
        user.achievements.push(badgeId);

        // Sauvegarde l'utilisateur
        const { resource: updatedUser } = await usersContainer.item(userId).replace(user);
        
        delete updatedUser.password;
        // Renvoie l'utilisateur mis à jour pour que le frontend puisse rafraîchir currentUser
        res.status(201).json({ message: "Badge débloqué !", badgeId: badgeId, user: updatedUser });

    } catch (error) {
        console.error("Erreur lors du déblocage du badge:", error);
        res.status(500).json({ error: "Erreur du serveur." });
    }
});
app.get('/api/teacher/classes', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { teacherEmail } = req.query;
    const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.json(classes);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});
app.post('/api/teacher/classes', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { className, teacherEmail } = req.body;
    const newClass = {
        className, teacherEmail,
        id: `class-${Date.now()}`,
        students: [], content: [], results: []
    };
    try {
        const { resource: createdClass } = await classesContainer.items.create(newClass);
        res.status(201).json(createdClass);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la création de la classe." }); }
});
app.get('/api/teacher/classes/:id', async (req, res) => {
    if (!classesContainer || !usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { teacherEmail } = req.query;
    try {
        const { resource: classData } = await classesContainer.item(req.params.id, teacherEmail).read();
        if (!classData) return res.status(404).json({ error: 'Classe introuvable' });
        if (classData.students && classData.students.length > 0) {
            const querySpec = { query: `SELECT c.email, c.firstName, c.avatar FROM c WHERE ARRAY_CONTAINS(@studentEmails, c.email)`, parameters: [{ name: '@studentEmails', value: classData.students }] };
            const { resources: studentsDetails } = await usersContainer.items.query(querySpec).fetchAll();
            classData.studentsWithDetails = studentsDetails;
        } else {
            classData.studentsWithDetails = [];
        }
        res.json(classData);
    } catch (error) {
        if (error.code === 404) {
            return res.status(404).json({ error: 'Classe introuvable' });
        }
        console.error(`Erreur pour la classe ${req.params.id} et prof ${teacherEmail}:`, error);
        res.status(500).json({ error: "Impossible de récupérer les détails de la classe." });
    }
});
app.post('/api/teacher/classes/:id/add-student', async (req, res) => {
    if (!classesContainer || !usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { studentEmail, teacherEmail } = req.body;
    const { id: classId } = req.params;
    try {
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student || student.role !== 'student') return res.status(404).json({ error: "Élève introuvable ou l'email n'est pas un compte élève." });
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        if (classData.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });
        classData.students.push(studentEmail);
        await classesContainer.items.upsert(classData);
        res.status(200).json(classData);
    } catch (error) {
        if (error.code === 404) return res.status(404).json({ error: "Élève ou classe introuvable." });
        res.status(500).json({ error: "Erreur serveur." });
    }
});
app.post('/api/teacher/assign-content', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { classId, contentData, teacherEmail } = req.body;
    const newContent = {
        ...contentData,
        id: `content-${Date.now()}`,
        assignedAt: new Date().toISOString()
    };
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        if (!classDoc) return res.status(404).json({ error: 'Classe introuvable' });
        classDoc.content = classDoc.content || [];
        classDoc.content.push(newContent);
        await classesContainer.items.upsert(classDoc);
        res.status(200).json(newContent);
    } catch (error) { res.status(500).json({ error: "Erreur lors de l'assignation." }); }
});
app.post('/api/teacher/classes/reorder', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { teacherEmail, classOrder } = req.body;
    try {
        const { resource: teacher } = await usersContainer.item(teacherEmail, teacherEmail).read();
        teacher.classOrder = classOrder;
        const { resource: updatedTeacher } = await usersContainer.items.upsert(teacher);
        res.status(200).json({ classOrder: updatedTeacher.classOrder });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la mise à jour de l'ordre." }); }
});
app.delete('/api/teacher/classes/:classId/content/:contentId', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { classId, contentId } = req.params;
    const { teacherEmail } = req.query;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        classDoc.content = classDoc.content.filter(c => c.id !== contentId);
        classDoc.results = classDoc.results.filter(r => r.contentId !== contentId);
        await classesContainer.items.upsert(classDoc);
        res.status(204).send();
    } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});
app.post('/api/teacher/classes/:classId/remove-student', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { classId } = req.params;
    const { studentEmail, teacherEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        classDoc.students = classDoc.students.filter(email => email !== studentEmail);
        classDoc.results = classDoc.results.filter(r => r.studentEmail !== studentEmail);
        await classesContainer.items.upsert(classDoc);
        res.status(204).send();
    } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});
app.post('/api/teacher/validate-result', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { classId, studentEmail, contentId, appreciation, comment, teacherEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        const resultIndex = classDoc.results.findIndex(r => r.studentEmail === studentEmail && r.contentId === contentId);
        if (resultIndex === -1) return res.status(404).json({ error: "Résultat non trouvé." });
        classDoc.results[resultIndex].status = 'validated';
        classDoc.results[resultIndex].appreciation = appreciation;
        classDoc.results[resultIndex].teacherComment = comment;
        classDoc.results[resultIndex].validatedAt = new Date().toISOString();
        await classesContainer.items.upsert(classDoc);
        res.status(200).json(classDoc.results[resultIndex]);
    } catch(error) { res.status(500).json({ error: "Erreur lors de la validation." }); }
});
app.get('/api/teacher/classes/:classId/competency-report', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { classId } = req.params;
    const { teacherEmail } = req.query;
    try {
        const { resource: classData } = await classesContainer.item(classId, teacherEmail).read();
        const validatedQuizzes = (classData.results || []).filter(r => r.status === 'validated' && r.totalQuestions > 0);
        const competencyScores = {};
        validatedQuizzes.forEach(result => {
            const content = (classData.content || []).find(c => c.id === result.contentId);
            if (content && content.competence && content.competence.competence) {
                const { competence, level } = content.competence;
                if (!competencyScores[competence]) {
                    competencyScores[competence] = { scores: [], total: 0, level };
                }
                const scorePercentage = (result.score / result.totalQuestions) * 100;
                competencyScores[competence].scores.push(scorePercentage);
                competencyScores[competence].total += scorePercentage;
            }
        });
        const report = Object.keys(competencyScores).map(competence => ({
            competence,
            level: competencyScores[competence].level,
            averageScore: Math.round(competencyScores[competence].total / competencyScores[competence].scores.length)
        }));
        res.json(report);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la génération du rapport." }); }
});
app.get('/api/student/dashboard', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { studentEmail } = req.query;
    const querySpec = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: "@studentEmail", value: studentEmail }] };
    try {
        const { resources: studentClasses } = await classesContainer.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
        const todo = [], pending = [], completed = [];
        studentClasses.forEach(c => {
            (c.content || []).forEach(content => {
                const result = (c.results || []).find(r => r.studentEmail === studentEmail && r.contentId === content.id);
                const item = { ...content, className: c.className, classId: c.id, teacherEmail: c.teacherEmail };
                if (!result) { todo.push(item); }
                else {
                    const fullResult = { ...item, ...result };
                    if (result.status === 'pending_validation') { pending.push(fullResult); }
                    else if (result.status === 'validated') { completed.push(fullResult); }
                }
            });
        });
        todo.sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));
        pending.sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
        completed.sort((a,b) => new Date(b.validatedAt) - new Date(a.validatedAt));
        res.json({ todo, pending, completed });
    } catch (error) { 
        console.error("Erreur de récupération du tableau de bord étudiant:", error);
        res.status(500).json({ error: "Erreur de récupération du tableau de bord." }); 
    }
});
app.post('/api/student/submit-quiz', async (req, res) => {
    if (!classesContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers, helpUsed, teacherEmail } = req.body;
    const newResult = { studentEmail, contentId, title, score, totalQuestions, answers, helpUsed, submittedAt: new Date().toISOString(), status: 'pending_validation' };
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        classDoc.results = classDoc.results || [];
        classDoc.results.push(newResult);
        await classesContainer.items.upsert(classDoc);
        res.status(201).json(newResult);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la soumission." }); }
});
app.get('/api/library', async (req, res) => {
    if (!libraryContainer) return res.status(503).json({ error: "Service de bibliothèque indisponible." });
    const { searchTerm, subject } = req.query;
    let query = "SELECT * FROM c";
    const parameters = [];
    const conditions = [];
    if (subject) {
        conditions.push("c.subject = @subject");
        parameters.push({ name: "@subject", value: subject });
    }
    if (searchTerm) {
        conditions.push("CONTAINS(c.title, @searchTerm, true)"); 
        parameters.push({ name: "@searchTerm", value: searchTerm });
    }
    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY c.publishedAt DESC";
    const querySpec = { query, parameters };
    try {
        const options = { enableCrossPartitionQuery: !subject };
        const { resources: items } = await libraryContainer.items.query(querySpec, options).fetchAll();
        res.json(items);
    } catch (error) {
        console.error("Erreur de recherche dans la bibliothèque:", error);
        res.status(500).json({ error: "Impossible de récupérer la bibliothèque." });
    }
});
app.post('/api/library/publish', async (req, res) => {
    if (!libraryContainer) return res.status(503).json({ error: "Service de bibliothèque indisponible." });
    const { contentData, teacherName, subject } = req.body;
    if (!contentData || !teacherName || !subject) {
        return res.status(400).json({ error: "Données de publication incomplètes." });
    }
    const newLibraryItem = {
        ...contentData,
        id: `lib-${contentData.id || Date.now()}`, 
        originalContentId: contentData.id,
        authorName: teacherName,
        publishedAt: new Date().toISOString(),
        subject: subject 
    };
    delete newLibraryItem.assignedAt;
    delete newLibraryItem.dueDate;
    delete newLibraryItem.isEvaluated;
    delete newLibraryItem.classId;
    delete newLibraryItem.teacherEmail;
    try {
        const { resource: publishedItem } = await libraryContainer.items.create(newLibraryItem);
        res.status(201).json(publishedItem);
    } catch (error) {
         if (error.code === 409) {
             res.status(409).json({ error: "Ce contenu (ou un contenu avec le même ID) existe déjà dans la bibliothèque." });
         } else {
             console.error("Erreur de publication dans la bibliothèque:", error);
             res.status(500).json({ error: "Erreur lors de la publication." });
         }
    }
});
app.post('/api/ai/generate-content', async (req, res) => {
    const { competences, contentType, exerciseCount, language } = req.body;
    const langMap = { 'Anglais': 'English', 'Arabe': 'Arabic', 'Espagnol': 'Spanish' };
    const targetLanguage = langMap[language];
    let systemPrompt;
    let userPromptContent;
    const baseInstructions = {
        quiz: `Génère exactement ${exerciseCount} questions. La structure JSON DOIT être : { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`,
        exercices: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "exercices", "content": [ { "enonce": "..." } ] }`,
        dm: `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "dm", "content": [ { "enonce": "..." } ] }`,
        revision: `Génère une fiche de révision complète. La structure JSON DOIT être : { "title": "...", "type": "revision", "content": "..." }`
    };
    if (!baseInstructions[contentType]) {
        return res.status(400).json({ error: "Type de contenu non supporté" });
    }
    if (targetLanguage) {
        systemPrompt = `You are an expert pedagogical assistant for creating language learning content. Your entire response must be a valid JSON object only, with no text before or after. All text content within the JSON MUST be in ${targetLanguage}.`;
        const translatedInstructions = {
            quiz: `Generate exactly ${exerciseCount} questions. The JSON structure MUST be: { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`,
            exercices: `Generate exactly ${exerciseCount} exercises. The JSON structure MUST be: { "title": "...", "type": "exercices", "content": [ { "enonce": "..." } ] }`,
            dm: `Generate exactly ${exerciseCount} exercises. The JSON structure MUST be: { "title": "...", "type": "dm", "content": [ { "enonce": "..." } ] }`,
            revision: `Generate a complete review sheet. The JSON structure MUST be: { "title": "...", "type": "revision", "content": "..." }`
        };
        const specificInstructions = translatedInstructions[contentType];
        userPromptContent = `I will provide a pedagogical skill described in French. Your task is to create a '${contentType}' in ${targetLanguage} for a student learning that language. The exercise should help them practice the provided skill. The French skill is: '${competences}'. Now, follow these structural rules: ${specificInstructions}`;
    } else {
        systemPrompt = "Tu es un assistant pédagogique expert dans la création de contenus éducatifs en français. Ta réponse doit être uniquement un objet JSON valide, sans aucun texte avant ou après.";
        const specificInstructions = baseInstructions[contentType];
        userPromptContent = `Crée un contenu de type '${contentType}' pour un élève, basé sur la compétence suivante : '${competences}'. ${specificInstructions} Le contenu doit être en français.`;
    }
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPromptContent }
            ],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        const structured_content = response.data.choices[0].message.content;
        res.json({ structured_content: JSON.parse(structured_content) });
    } catch (error) {
        console.error("Erreur Deepseek:", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur lors de la génération." });
    }
});
app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!formRecognizerClient) { return res.status(503).json({ error: "Le service d'analyse de documents n'est pas configuré sur le serveur. Vérifiez les logs." }); }
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été chargé." });
    const { contentType, exerciseCount } = req.body;
    let specificInstructions = '';
    switch(contentType) {
        case 'quiz':
            specificInstructions = `Génère exactement ${exerciseCount} questions. La structure JSON DOIT être : { "title": "...", "type": "quiz", "questions": [ { "question_text": "...", "options": ["...", "...", "...", "..."], "correct_answer_index": 0 } ] }`;
            break;
        case 'exercices':
        case 'dm':
            specificInstructions = `Génère exactement ${exerciseCount} exercices. La structure JSON DOIT être : { "title": "...", "type": "${contentType}", "content": [ { "enonce": "..." } ] }`;
            break;
        case 'revision':
            specificInstructions = `Génère une fiche de révision. La structure JSON DOIT être : { "title": "...", "type": "revision", "content": "..." }`;
            break;
    }
    try {
        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", req.file.buffer);
        const { content } = await poller.pollUntilDone();
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [{
                role: "system",
                content: "Tu es un assistant pédagogique expert. Ta réponse doit être uniquement un objet JSON valide, sans texte additionnel."
            }, {
                role: "user",
                content: `À partir du texte suivant: "${content}". Crée un contenu de type '${contentType}'. ${specificInstructions}`
            }],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        const structured_content = response.data.choices[0].message.content;
        res.json({ structured_content: JSON.parse(structured_content) });
    } catch (error) {
        console.error("Erreur lors de l'analyse ou de la génération:", error);
        res.status(500).json({ error: "Erreur du serveur." });
    }
});

// ▼▼▼ CETTE ROUTE MANQUAIT PROBABLEMENT SUR AZURE ▼▼▼
app.post('/api/ai/playground-extract-text', upload.single('document'), async (req, res) => {
    if (!formRecognizerClient) { return res.status(503).json({ error: "Le service d'analyse de documents n'est pas configuré sur le serveur. Vérifiez les logs." }); }
    if (!req.file) { return res.status(400).json({ error: "Aucun fichier n'a été chargé." }); }
    try {
        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", req.file.buffer);
        const { content } = await poller.pollUntilDone();
        res.json({ extractedText: content });
    } catch (error) {
        console.error("Erreur lors de l'extraction de texte:", error);
        res.status(500).json({ error: "Impossible d'analyser le document." });
    }
});
// ▲▲▲ FIN DE LA ROUTE ▲▲▲

app.post('/api/ai/get-hint', async (req, res) => {
    const { questionText } = req.body;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [{
                role: "system",
                content: "Tu es un tuteur. Donne un indice pour aider à résoudre la question, mais ne donne JAMAIS la réponse. Sois bref et encourageant."
            }, { role: "user", content: `Donne un indice pour la question : "${questionText}"` }]
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "Indice indisponible." }); }
});
app.post('/api/ai/generate-lesson-plan', async (req, res) => {
    const { theme, level, numSessions } = req.body;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [{
                role: "system",
                content: "Tu es un concepteur pédagogique expert. Génère un plan de cours structuré en JSON. Ta réponse doit être uniquement un objet JSON valide."
            }, {
                role: "user",
                content: `Crée un plan de cours sur le thème "${theme}" pour un niveau "${level}" en ${numSessions} séances. Pour chaque séance, donne un titre, un objectif, des idées d'activités et des suggestions de ressources AIDA. Pour chaque ressource suggérée, fournis un objet JSON avec les clés "type" (choisi parmi "quiz", "exercices", "revision", "dm"), "sujet" (un titre court et descriptif), et "competence" (une compétence pédagogique précise et complète liée au sujet). La structure JSON finale doit être : { "planTitle": "...", "level": "...", "sessions": [{ "sessionNumber": 1, "title": "...", "objective": "...", "activities": ["..."], "resources": [{"type": "quiz", "sujet": "Les capitales européennes", "competence": "Localiser les principales capitales européennes sur une carte"}] }] }.`
            }],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        res.json({ structured_plan: JSON.parse(response.data.choices[0].message.content) });
    } catch (error) { 
        console.error("Erreur Deepseek (planificateur):", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur lors de la génération du plan de cours." });
    }
});
app.post('/api/ai/grade-upload', upload.array('copies', 10), async (req, res) => {
    if (!formRecognizerClient || !process.env.DEEPSEEK_API_KEY) {
        return res.status(503).json({ error: "Les services d'analyse IA ou Document ne sont pas configurés sur le serveur." });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "Aucun fichier de copie n'a été reçu." });
    }
    const { sujet, criteres } = req.body;
    if (!sujet || !criteres) {
        return res.status(400).json({ error: "Le sujet et les critères de notation sont obligatoires." });
    }
    try {
        console.log(`[Grading Module] Analyse OCR de ${req.files.length} page(s)...`);
        const ocrPromises = req.files.map(async (file) => {
            const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", file.buffer);
            const { content } = await poller.pollUntilDone();
            console.log(`[Grading Module] Texte extrait de ${file.originalname} (${content.length} caractères).`);
            return content;
        });
        const allTextSnippets = await Promise.all(ocrPromises);
        const fullText = allTextSnippets.join("\n\n--- PAGE SUIVANTE ---\n\n");
        console.log(`[Grading Module] Texte total combiné: ${fullText.length} caractères.`);
        const systemPrompt = `Tu es un assistant de correction expert pour enseignants. Tu reçois le SUJET d'un devoir, les CRITÈRES de notation, et le TEXTE COMPLET d'une copie d'élève (qui peut s'étendre sur plusieurs pages, séparées par "--- PAGE SUIVANTE ---").
        Ton objectif est de fournir une évaluation structurée et objective.
        Ta réponse DOIT être un objet JSON valide, et rien d'autre.
        
        Voici la structure JSON ATTENDUE:
        {
          "analyseGlobale": "Une analyse claire et structurée...",
          "criteres": [
            { "nom": "Pertinence du contenu", "note": "X/Y", "commentaire": "..." },
            { "nom": "Organisation et cohérence", "note": "X/Y", "commentaire": "..." }
          ],
          "noteFinale": "X/20",
          "commentaireEleve": "Travail remarquable. L'essai est clair..."
        }`;
        const userPrompt = `Voici la correction à effectuer :
        
        1. SUJET DU DEVOIR:
        "${sujet}"

        2. CRITÈRES DE NOTATION:
        "${criteres}"

        3. TEXTE COMPLET DE LA COPIE DE L'ÉLÈVE (extrait par OCR):
        "${fullText}"

        Génère l'évaluation JSON structurée correspondante.`;
        console.log(`[Grading Module] Envoi de la requête unique à Deepseek...`);
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        console.log(`[Grading Module] Réponse IA reçue.`);
        const evaluationJson = JSON.parse(response.data.choices[0].message.content);
        res.json(evaluationJson);
    } catch (error) {
        console.error("Erreur dans le module d'aide à la correction:", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur lors de l'analyse des copies." });
    }
});
app.post('/api/ai/get-aida-help', async (req, res) => {
    const { history, level } = req.body;
    if (!history) { return res.status(400).json({ error: "L'historique de la conversation est manquant." }); }
    const systemPrompt = `Tu es AIDA, un tuteur IA bienveillant et pédagogue. Ton objectif est de guider les élèves vers la solution sans jamais donner la réponse directement, sauf en dernier recours. 
    CONTEXTE IMPORTANT : L'élève que tu aides est au niveau [${level || 'non spécifié'}]. 
    Tu dois adapter ton langage et la complexité de tes indices à ce niveau. Suis une méthode socratique : questionner d'abord, donner un indice ensuite, et valider la compréhension de l'élève.`;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [ 
                { role: "system", content: systemPrompt },
                ...history 
            ]
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        const reply = response.data.choices[0].message.content;
        res.json({ response: reply });
    } catch (error) {
        console.error("Erreur lors de la communication avec l'API Deepseek pour l'aide modale:", error.response?.data || error.message);
        res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA." });
    }
});
// --- FIN AIDA ÉDUCATION ---


// --- ACADEMY AUTH ROUTES ---
// DANS server.js
app.post('/api/academy/auth/login', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        const isAcademyRole = user?.role?.startsWith('academy_');

        if (user && isAcademyRole && user.password === password) {
            
            // --- ▼▼▼ DÉBUT DE LA LOGIQUE DE STREAK ▼▼▼ ---
            if (user.role === 'academy_student') {
                const today = new Date().toISOString().split('T')[0];
                const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                
                // Initialise les champs s'ils n'existent pas (pour les anciens utilisateurs)
                let streak = user.dailyStreak || { count: 0, lastLogin: null };
                user.achievements = user.achievements || [];

                if (streak.lastLogin === yesterday) {
                    // Connexion consécutive
                    streak.count++;
                    streak.lastLogin = today;
                } else if (streak.lastLogin !== today) {
                    // Streak brisée ou première connexion
                    streak.count = 1;
                    streak.lastLogin = today;
                }
                // Si lastLogin === today, on ne fait rien (l'utilisateur s'est déjà connecté aujourd'hui)

                user.dailyStreak = streak;

                // Débloque automatiquement un badge de streak (Exemple : 3 jours)
                if (streak.count >= 3 && !user.achievements.includes('streak_3')) {
                    user.achievements.push('streak_3');
                }
                
                // Sauvegarde l'utilisateur avec la streak mise à jour
                await usersContainer.item(user.id).replace(user);
            }
            // --- ▲▲▲ FIN DE LA LOGIQUE DE STREAK ▲▲▲ ---

            delete user.password;
            res.json({ user }); // Renvoie l'utilisateur mis à jour
        } else {
            res.status(401).json({ error: "Email, mot de passe ou rôle incorrect pour l'Académie." });
        }
    } catch (error) {
        if (error.code === 404) {
            res.status(401).json({ error: "Email, mot de passe ou rôle incorrect pour l'Académie." });
        } else {
            console.error("Erreur de connexion Académie:", error);
            res.status(500).json({ error: "Erreur du serveur." });
        }
    }
});
// FIN ACADEMY AUTH

// --- ACADEMY MRE : CHAT & VOIX ---

// OPTIMISATION : Route TTS unique
app.post('/api/ai/synthesize-speech', async (req, res) => {
    if (!ttsClient) { return res.status(500).json({ error: "Le service de synthèse vocale n'est pas configuré sur le serveur." }); }
    const { text, voice, rate, pitch } = req.body;
    if (!text) return res.status(400).json({ error: "Le texte est manquant." });

    // ▼▼▼ AJOUT : Nettoyage du texte ▼▼▼
    // Regex pour supprimer les emojis et les caractères Markdown (comme *, #)
    // que l'IA pourrait inclure dans sa réponse.
    const cleanedText = text
        .replace(/([\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}])/gu, '') // Supprime les emojis
        .replace(/[*#_`]/g, ''); // Supprime les marqueurs markdown

    const request = { 
        // ▼▼▼ MODIFIÉ : Utilise le texte nettoyé ▼▼▼
        input: { text: cleanedText }, 
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

// Route pour le chat immersif (LLM)
app.post('/api/academy/ai/chat', async (req, res) => {
    const { history, response_format } = req.body;
    if (!history) { return res.status(400).json({ error: "L'historique de la conversation est manquant." }); }
    try {
        const deepseekBody = {
            model: "deepseek-chat",
            messages: history
        };
        if (response_format) {
             deepseekBody.response_format = response_format;
        }
        const response = await axios.post('https://api.deepseek.com/chat/completions', deepseekBody, { 
            headers: { 
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            } 
        });
        const reply = response.data.choices[0].message.content;
        res.json({ reply });
    } catch (error) {
        console.error("Erreur Deepseek (Académie MRE):", error.response?.data || error.message);
        res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA pour l'Académie." });
    }
});


// --- ACADEMY MRE : SUIVI ET GESTION (Routes Cosmos DB) ---

app.post('/api/academy/session/save', async (req, res) => {
    if (!usersContainer) { 
        console.error("Erreur 503: Conteneur d'utilisateurs non disponible.");
        return res.status(503).json({ error: "Service de base de données indisponible." }); 
    }
    const { userId, scenarioId, report, fullHistory } = req.body;
    if (!userId || !scenarioId || !report) {
        return res.status(400).json({ error: "Données de session incomplètes." });
    }
    const newSession = {
        id: `session-${Date.now()}-${userId}`,
        userId: userId,
        scenarioId: scenarioId,
        completedAt: new Date().toISOString(),
        report: report, 
        fullHistory: fullHistory 
    };
    try {
        const { resource: user } = await usersContainer.item(userId, userId).read();
        if (!user) {
            return res.status(404).json({ error: "Utilisateur non trouvé." });
        }
        user.academyProgress = user.academyProgress || {};
        user.academyProgress.sessions = user.academyProgress.sessions || [];
        user.academyProgress.sessions.push(newSession);
        await usersContainer.items.upsert(user);
        res.status(201).json({ message: "Session enregistrée avec succès.", sessionId: newSession.id });
    } catch (error) { 
        console.error("Erreur lors de la sauvegarde de la session Académie:", error.message);
        res.status(500).json({ error: "Erreur serveur lors de la sauvegarde de la session." }); 
    }
});

app.get('/api/academy/scenarios', async (req, res) => {
    if (!scenariosContainer) { 
        console.warn("Conteneur Scenarios non initialisé. Utilisation du Fallback.");
        return res.json(defaultScenarios);
    }
    try {
        const { resources: dbScenarios } = await scenariosContainer.items.readAll().fetchAll();
        if (dbScenarios.length === 0) {
            return res.json(defaultScenarios);
        }
        const allScenariosMap = new Map();
        defaultScenarios.forEach(s => allScenariosMap.set(s.id, s));
        dbScenarios.forEach(s => allScenariosMap.set(s.id, s));
        res.json(Array.from(allScenariosMap.values()));
    } catch (error) {
        console.error("Erreur lors de la lecture des scénarios depuis la DB:", error.message);
        res.json(defaultScenarios); 
    }
});

app.post('/api/academy/scenarios/create', async (req, res) => {
    if (!scenariosContainer) { 
        return res.status(503).json({ error: "Conteneur de scénarios non disponible." }); 
    }
    const newScenario = req.body;
    if (!newScenario.title || !newScenario.characterIntro) {
        return res.status(400).json({ error: "Les données de scénario sont incomplètes." });
    }
    const scenarioToInsert = {
        id: `scen-${Date.now()}`, 
        voiceCode: newScenario.voiceCode || 'ar-XA-Wavenet-B', 
        createdAt: new Date().toISOString(),
        ...newScenario
    };
    try {
        const { resource: createdScenario } = await scenariosContainer.items.create(scenarioToInsert);
        console.log(`[SCENARIO CREATED] ID: ${createdScenario.id}, Title: ${createdScenario.title}`);
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

// --- Point d'entrée et démarrage du serveur ---
const PORT = process.env.PORT || 3000;

initializeDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server AIDA démarré sur le port ${PORT}`);
    });
}).catch((error) => {
    console.error("Le serveur ne peut pas démarrer en raison d'une erreur critique de DB:", error.message);
    process.exit(1); 
});