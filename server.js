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
const corsOptions = { origin: '*', methods: "GET,HEAD,PUT,PATCH,POST,DELETE", optionsSuccessStatus: 200 };
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage() });

// --- 2. Initialisation des Services Azure & Google ---
let dbClient, blobServiceClient, formRecognizerClient, ttsClient;
try {
    dbClient = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    formRecognizerClient = new DocumentAnalysisClient(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY));
    console.log("Clients Azure initialisés avec succès.");
} catch(e) {
    console.error("ERREUR CRITIQUE: Impossible d'initialiser les clients Azure. Vérifiez les variables d'environnement.", e);
}

try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
        const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        ttsClient = new TextToSpeechClient({ credentials });
        console.log("Client Google Cloud Text-to-Speech prêt (via JSON).");
    } else {
         throw new Error("Variable d'environnement GOOGLE_APPLICATION_CREDENTIALS_JSON non trouvée.");
    }
} catch(e) {
    console.warn("N'a pas pu initialiser Google Cloud TTS. Assurez-vous que la variable GOOGLE_APPLICATION_CREDENTIALS_JSON est configurée sur Azure.", e.message);
    ttsClient = null;
}

const database = dbClient?.database('AidaDB');
const usersContainer = database?.container('Users');
const classesContainer = database?.container('Classes');
const completedContentContainer = database?.container('CompletedContent');
const libraryContainer = database?.container('Library');


// --- Routes API ---

// AUTH
app.post('/api/auth/login', async (req, res) => {
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
    const { teacherEmail } = req.query;
    const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.json(classes);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});

app.post('/api/teacher/classes', async (req, res) => {
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
    try {
        const { resource: classData } = await classesContainer.item(req.params.id, undefined).read();
        if (!classData) return res.status(404).json({ error: 'Classe introuvable' });

        if (classData.students && classData.students.length > 0) {
            const querySpec = { query: `SELECT c.email, c.firstName, c.avatar FROM c WHERE ARRAY_CONTAINS(@studentEmails, c.email)`, parameters: [{ name: '@studentEmails', value: classData.students }]};
            const { resources: studentsDetails } = await usersContainer.items.query(querySpec).fetchAll();
            classData.studentsWithDetails = studentsDetails;
        } else {
            classData.studentsWithDetails = [];
        }
        res.json(classData);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les détails de la classe." }); }
});

app.post('/api/teacher/classes/:id/add-student', async (req, res) => {
    const { studentEmail } = req.body;
    try {
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student || student.role !== 'student') return res.status(404).json({ error: "Élève introuvable ou l'email n'est pas un compte élève." });
        
        const { resource: classData } = await classesContainer.item(req.params.id, undefined).read();
        if (classData.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });

        classData.students.push(studentEmail);
        await classesContainer.items.upsert(classData);
        res.status(200).json(classData);
    } catch (error) {
        if (error.code === 404) return res.status(404).json({ error: "Élève introuvable." });
        res.status(500).json({ error: "Erreur serveur." });
    }
});

app.post('/api/teacher/assign-content', async (req, res) => {
    const { classId, contentData } = req.body;
    const newContent = {
        ...contentData,
        id: `content-${Date.now()}`,
        assignedAt: new Date().toISOString()
    };
    try {
        const { resource: classDoc } = await classesContainer.item(classId, undefined).read();
        if (!classDoc) return res.status(404).json({ error: 'Classe introuvable' });
        classDoc.content = classDoc.content || [];
        classDoc.content.push(newContent);
        await classesContainer.items.upsert(classDoc);
        res.status(200).json(newContent);
    } catch (error) { res.status(500).json({ error: "Erreur lors de l'assignation." }); }
});

app.post('/api/teacher/classes/reorder', async (req, res) => {
    const { teacherEmail, classOrder } = req.body;
    try {
        const { resource: teacher } = await usersContainer.item(teacherEmail, teacherEmail).read();
        teacher.classOrder = classOrder;
        const { resource: updatedTeacher } = await usersContainer.items.upsert(teacher);
        res.status(200).json({ classOrder: updatedTeacher.classOrder });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la mise à jour de l'ordre." }); }
});

app.delete('/api/teacher/classes/:classId/content/:contentId', async (req, res) => {
    const { classId, contentId } = req.params;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, undefined).read();
        classDoc.content = classDoc.content.filter(c => c.id !== contentId);
        classDoc.results = classDoc.results.filter(r => r.contentId !== contentId);
        await classesContainer.items.upsert(classDoc);
        res.status(204).send();
    } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});

app.post('/api/teacher/classes/:classId/remove-student', async (req, res) => {
    const { classId } = req.params;
    const { studentEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, undefined).read();
        classDoc.students = classDoc.students.filter(email => email !== studentEmail);
        classDoc.results = classDoc.results.filter(r => r.studentEmail !== studentEmail);
        await classesContainer.items.upsert(classDoc);
        res.status(204).send();
    } catch (error) { res.status(500).json({ error: "Erreur lors de la suppression." }); }
});

app.post('/api/teacher/validate-result', async (req, res) => {
    const { classId, studentEmail, contentId, appreciation, comment } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, undefined).read();
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
    const { classId } = req.params;
    try {
        const { resource: classData } = await classesContainer.item(classId, undefined).read();
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
    const { studentEmail } = req.query;
    const querySpec = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: "@studentEmail", value: studentEmail }] };
    try {
        const { resources: studentClasses } = await classesContainer.items.query(querySpec).fetchAll();
        const todo = [];
        const pending = [];
        const completed = [];
        
        studentClasses.forEach(c => {
            (c.content || []).forEach(content => {
                const result = (c.results || []).find(r => r.studentEmail === studentEmail && r.contentId === content.id);
                const item = { ...content, className: c.className, classId: c.id };
                if (!result) {
                    todo.push(item);
                } else {
                    const fullResult = { ...item, ...result };
                    if (result.status === 'pending_validation') {
                        pending.push(fullResult);
                    } else if (result.status === 'validated') {
                        completed.push(fullResult);
                    }
                }
            });
        });

        todo.sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));
        pending.sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
        completed.sort((a,b) => new Date(b.validatedAt) - new Date(a.validatedAt));

        res.json({ todo, pending, completed });
    } catch (error) { res.status(500).json({ error: "Erreur de récupération du tableau de bord." }); }
});

app.post('/api/student/submit-quiz', async (req, res) => {
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers, helpUsed } = req.body;
    const newResult = {
        studentEmail, contentId, title, score, totalQuestions, answers, helpUsed,
        submittedAt: new Date().toISOString(),
        status: 'pending_validation'
    };
    try {
        const { resource: classDoc } = await classesContainer.item(classId, undefined).read();
        classDoc.results = classDoc.results || [];
        classDoc.results.push(newResult);
        await classesContainer.items.upsert(classDoc);
        res.status(201).json(newResult);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la soumission." }); }
});

// IA & GENERATION
app.post('/api/ai/generate-content', async (req, res) => {
    const { competences, contentType, exerciseCount } = req.body;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: "deepseek-chat",
            messages: [{
                role: "system",
                content: "Tu es un assistant pédagogique expert dans la création de contenus éducatifs en français. Ta réponse doit être uniquement un objet JSON valide, sans aucun texte avant ou après."
            }, {
                role: "user",
                content: `Crée un contenu de type '${contentType}' pour un élève, basé sur la compétence suivante : '${competences}'. Le contenu doit inclure un titre. Si le type est 'quiz', 'exercices' ou 'dm', génère exactement ${exerciseCount} questions ou énoncés. Si c'est un quiz, chaque question doit avoir 4 options de réponse et l'index de la bonne réponse. Si c'est 'exercices' ou 'dm', chaque exercice doit avoir un énoncé. Si c'est 'revision', génère un texte de révision. Le JSON doit avoir la structure suivante : { "title": "...", "type": "...", "questions": [...] } ou { "title": "...", "type": "...", "content": [...] } ou { "title": "...", "type": "...", "content": "..." }.`
            }],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });

        const structured_content = response.data.choices[0].message.content;
        res.json({ structured_content: JSON.parse(structured_content) });
    } catch (error) {
        console.error("Erreur Deepseek:", error.response?.data);
        res.status(500).json({ error: "Erreur lors de la génération." });
    }
});

app.post('/api/ai/generate-from-upload', upload.single('document'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier n'a été chargé." });
    try {
        const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-layout", req.file.buffer);
        const { content } = await poller.pollUntilDone();
        
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
             model: "deepseek-chat",
             messages: [{
                role: "system",
                content: "Tu es un assistant pédagogique expert dans la création de contenus éducatifs en français à partir d'un texte fourni. Ta réponse doit être uniquement un objet JSON valide."
            }, {
                role: "user",
                content: `À partir du texte suivant : "${content}". Crée un contenu de type '${req.body.contentType}' avec ${req.body.exerciseCount} questions/exercices. Le JSON doit avoir la structure appropriée, comme pour la génération depuis une compétence.`
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
                content: "Tu es un concepteur pédagogique expert. Génère un plan de cours structuré en JSON."
            }, {
                role: "user",
                content: `Crée un plan de cours sur le thème "${theme}" pour un niveau "${level}" en ${numSessions} séances. Pour chaque séance, donne un titre, un objectif, des idées d'activités et des suggestions de ressources AIDA (quiz, fiche...). Le JSON doit avoir la structure: { "planTitle": "...", "level": "...", "sessions": [{ "sessionNumber": 1, "title": "...", "objective": "...", "activities": [...], "resources": [...] }] }.`
            }],
            response_format: { type: "json_object" }
        }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
        res.json({ structured_plan: JSON.parse(response.data.choices[0].message.content) });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la génération du plan." }); }
});

app.post('/api/ai/synthesize-speech', async (req, res) => {
    if (!ttsClient) {
        return res.status(500).json({ error: "Le service de synthèse vocale n'est pas configuré sur le serveur." });
    }
    const { text, voice, rate, pitch } = req.body;
    if (!text) return res.status(400).json({ error: "Le texte est manquant." });

    const request = {
        input: { text: text },
        voice: { languageCode: voice ? voice.substring(0, 5) : 'fr-FR', name: voice || 'fr-FR-Wavenet-E' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: parseFloat(rate) || 1.0, pitch: parseFloat(pitch) || 0.0, },
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


// BIBLIOTHÈQUE
app.post('/api/library/publish', async (req, res) => {
    const { contentData, teacherName, subject } = req.body;
    const libraryItem = {
        ...contentData,
        id: `lib-${Date.now()}`,
        authorName: teacherName,
        subject: subject,
        originalId: contentData.id
    };
    try {
        await libraryContainer.items.create(libraryItem);
        res.status(201).json(libraryItem);
    } catch (error) { res.status(500).json({ error: "Erreur lors de la publication." }); }
});

app.get('/api/library', async (req, res) => {
    const { searchTerm, subject } = req.query;
    let query = "SELECT * FROM c";
    const parameters = [];
    const conditions = [];

    if (searchTerm) {
        conditions.push("CONTAINS(c.title, @searchTerm, true)");
        parameters.push({ name: "@searchTerm", value: searchTerm });
    }
    if (subject) {
        conditions.push("c.subject = @subject");
        parameters.push({ name: "@subject", value: subject });
    }
    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
    }
    try {
        const { resources } = await libraryContainer.items.query({ query, parameters }).fetchAll();
        res.json(resources);
    } catch (error) { res.status(500).json({ error: "Impossible de charger la bibliothèque." }); }
});


// --- Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur AIDA démarré sur le port ${PORT}`));

