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
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// --- 3. Initialisation Express ---
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 2. Initialisation des Services Azure & Google ---
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
const usersContainer = database?.container('Users');
const classesContainer = database?.container('Classes');
const libraryContainer = database?.container('Library');

// --- Route Racine pour Vérification ---
app.get('/', (req, res) => {
    res.send('<h1>Serveur AIDA</h1><p>Le serveur est en ligne et fonctionne correctement.</p>');
});

// --- API Routes ---
// AUTH
app.post('/api/auth/login', async (req, res) => {
    if (!usersContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        if (user && user.password === password) {
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


// ENSEIGNANT
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


// ÉLÈVE
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

// IA & GENERATION
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

app.post('/api/ai/playground-extract-text', async (req, res) => {
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

// ROUTE AJOUTÉE POUR LA NOUVELLE MODAL D'AIDE DM/QUIZZ
app.post('/api/ai/get-aida-help', async (req, res) => {
    const { history } = req.body;
    if (!history) { return res.status(400).json({ error: "L'historique de la conversation est manquant." }); }
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [ { role: "system", content: "Tu es AIDA, un tuteur IA bienveillant et pédagogue. Ton objectif est de guider les élèves vers la solution sans jamais donner la réponse directement, sauf en dernier recours. Tu dois adapter ton langage à l'âge de l'élève et suivre une méthode socratique : questionner d'abord, donner un indice ensuite, et valider la compréhension de l'élève." }, ...history ]
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        const reply = response.data.choices[0].message.content;
        // NOTE: Le frontend (script.js) attend une clé 'response' pour la gestion générique des API.
        res.json({ response: reply });
    } catch (error) {
        console.error("Erreur lors de la communication avec l'API Deepseek pour l'aide modale:", error.response?.data || error.message);
        res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA." });
    }
});
// FIN ROUTE AJOUTÉE

app.post('/api/ai/playground-chat', async (req, res) => {
    const { history } = req.body;
    if (!history) { return res.status(400).json({ error: "L'historique de la conversation est manquant." }); }
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [ { role: "system", content: "Tu es AIDA, un tuteur IA bienveillant et pédagogue. Ton objectif est de guider les élèves vers la solution sans jamais donner la réponse directement, sauf en dernier recours. Tu dois adapter ton langage à l'âge de l'élève et suivre une méthode socratique : questionner d'abord, donner un indice ensuite, et valider la compréhension de l'élève." }, ...history ]
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        const reply = response.data.choices[0].message.content;
        res.json({ reply });
    } catch (error) {
        console.error("Erreur lors de la communication avec l'API Deepseek:", error.response?.data);
        res.status(500).json({ error: "Désolé, une erreur est survenue en contactant l'IA." });
    }
});


app.post('/api/ai/synthesize-speech', async (req, res) => {
    if (!ttsClient) { return res.status(500).json({ error: "Le service de synthèse vocale n'est pas configuré sur le serveur." }); }
    const { text, voice, rate, pitch } = req.body;
    if (!text) return res.status(400).json({ error: "Le texte est manquant." });
    const request = { input: { text: text }, voice: { languageCode: voice ? voice.substring(0, 5) : 'fr-FR', name: voice || 'fr-FR-Wavenet-E' }, audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) || 1.0, pitch: parseFloat(pitch) || 0.0, }, };
    try {
        const [response] = await ttsClient.synthesizeSpeech(request);
        const audioContent = response.audioContent.toString('base64');
        res.json({ audioContent });
    } catch (error) {
        console.error("Erreur lors de la synthèse vocale Google:", error);
        res.status(500).json({ error: "Impossible de générer l'audio." });
    }
});


// BIBLIOTHÈQUE
app.post('/api/library/publish', async (req, res) => {
    if (!libraryContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { contentData, teacherName, subject } = req.body;
    const libraryItem = { ...contentData, id: `lib-${Date.now()}`, authorName: teacherName, subject: subject, originalId: contentData.id };
    try {
        await libraryContainer.items.create(libraryItem);
        res.status(201).json(libraryItem);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la publication." }); }
});

app.get('/api/library', async (req, res) => {
    if (!libraryContainer) return res.status(503).json({ error: "Service de base de données indisponible." });
    const { searchTerm, subject } = req.query;
    let query = "SELECT * FROM c";
    const parameters = [];
    const conditions = [];
    if (searchTerm) { conditions.push("CONTAINS(c.title, @searchTerm, true)"); parameters.push({ name: "@searchTerm", value: searchTerm }); }
    if (subject) { conditions.push("c.subject = @subject"); parameters.push({ name: "@subject", value: subject }); }
    if (conditions.length > 0) { query += " WHERE " + conditions.join(" AND "); }
    try {
        const { resources } = await libraryContainer.items.query({ query, parameters }).fetchAll();
        res.json(resources);
    } catch (error) { res.status(500).json({ error: "Impossible de charger la bibliothèque." }); }
});


// --- Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur AIDA démarré sur le port ${PORT}`));