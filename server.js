// --- 1. Importer les outils nécessaires ---
const express = require('express');
const cors = require('cors'); 
require('dotenv').config();
const axios = require('axios');
const { CosmosClient } = require('@azure/cosmos');

// --- 2. Configuration & Initialisation ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint, key });
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent'; // Nouveau conteneur

async function setupDatabase() {
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container: usersContainer } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
  const { container: classesContainer } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
  // Création du nouveau conteneur pour les contenus terminés
  const { container: completedContentContainer } = await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });
  return { usersContainer, classesContainer, completedContentContainer };
}

let usersContainer;
let classesContainer;
let completedContentContainer; // Nouvelle variable de conteneur

// --- 3. Initialiser l'application ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); 
app.use(express.json());

// --- 4. Définir les "Routes" ---
const apiRouter = express.Router();

// Route pour l'explication d'AIDA
apiRouter.post('/generate/explanation', async (req, res) => {
    const { question, studentAnswer, correctAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    const prompt = `Un élève a mal répondu à cette question de quiz : "${question}". Sa réponse était "${studentAnswer}" alors que la bonne réponse était "${correctAnswer}". Explique-lui son erreur de manière simple, encourageante et pédagogique, en une ou deux phrases maximum. Adresse-toi directement à lui.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [{ content: prompt, role: 'user' }]
        }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        const explanation = response.data.choices[0].message.content;
        res.json({ explanation });
    } catch (error) {
        console.error("Erreur API DeepSeek:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "L'IA n'a pas pu générer d'explication." });
    }
});


apiRouter.post('/generate/content', async (req, res) => {
    const { competences, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    let jsonPrompt, textPrompt;
    switch (contentType) {
        case 'exercices':
            jsonPrompt = `Crée 3 exercices variés avec correction sur: "${competences}". Format JSON: {"title": "...", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}`;
            textPrompt = `Rédige 3 exercices clairs et variés avec leur correction détaillée sur la compétence suivante : "${competences}". Numérote chaque exercice. Sépare bien l'énoncé de la correction.`;
            break;
        case 'quiz':
        default:
            jsonPrompt = `Crée un quiz de 5 questions à 4 choix sur: "${competences}". Format JSON : {"title": "...", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`;
            textPrompt = `Rédige un quiz de 5 questions sur la compétence : "${competences}". Pour chaque question, propose 4 options de réponse (A, B, C, D) et indique la bonne réponse avec une étoile (*).`;
            break;
    }

    try {
        const jsonResponse = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: jsonPrompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let jsonString = jsonResponse.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        const jsonData = JSON.parse(jsonString);

        const textResponse = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: textPrompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        const textData = textResponse.data.choices[0].message.content;
        
        res.json({ structured_content: jsonData, text_representation: textData });
    } catch (error) { 
        res.status(500).json({ error: "L'IA a donné une réponse inattendue." }); 
    }
});

apiRouter.post('/convert/text-to-json', async (req, res) => {
    const { text, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    
    let prompt;
    switch (contentType) {
        case 'exercices':
            prompt = `Convertis ce texte d'exercices en format JSON: {"title": "...", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}. TEXTE : "${text}"`;
            break;
        case 'quiz':
        default:
            prompt = `Convertis ce texte de quiz en format JSON: {"title": "...", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}. La bonne réponse est marquée d'une étoile. TEXTE : "${text}"`;
            break;
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        const data = JSON.parse(jsonString);
        res.json(data);
    } catch(error) {
        res.status(500).json({ error: "Impossible de convertir le texte." });
    }
});

apiRouter.post('/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) {
        return res.status(400).json({ error: "Email, mot de passe et rôle sont requis." });
    }
    try {
        const { resource: existingUser } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (existingUser) {
            return res.status(409).json({ error: "Cet email est déjà utilisé." });
        }
        const newUser = { id: email, email, password, role, classes: [] };
        await usersContainer.items.create(newUser);
        res.status(201).json({ user: { email, role } });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la création du compte." });
    }
});

apiRouter.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
     if (!email || !password) {
        return res.status(400).json({ error: "Email et mot de passe sont requis." });
    }
    try {
        const { resource: user } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (!user || user.password !== password) {
            return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        }
        res.status(200).json({ user: { email: user.email, role: user.role } });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la connexion." });
    }
});

apiRouter.post('/classes/create', async (req, res) => {
    const { className, teacherEmail } = req.body;
    const newClass = {
        className,
        teacherEmail,
        students: [],
        quizzes: [],
        results: [],
        id: `${className.replace(/\s+/g, '-')}-${Date.now()}`
    };
    try {
        await classesContainer.items.create(newClass);
        res.status(201).json(newClass);
    } catch (error) {
        res.status(500).json({ error: "Impossible de créer la classe." });
    }
});

apiRouter.get('/classes/:teacherEmail', async (req, res) => {
    const { teacherEmail } = req.params;
    const querySpec = {
        query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail",
        parameters: [{ name: "@teacherEmail", value: teacherEmail }]
    };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.status(200).json(classes);
    } catch (error) {
        res.status(500).json({ error: "Impossible de récupérer les classes." });
    }
});

apiRouter.get('/class/details/:classId', async (req, res) => {
    const { classId } = req.params;
     try {
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @classId",
            parameters: [{ name: "@classId", value: classId }]
        };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) {
            return res.status(404).json({ error: "Classe non trouvée." });
        }
        res.status(200).json(resources[0]);
    } catch (error) {
        res.status(500).json({ error: "Impossible de récupérer les détails de la classe." });
    }
});

apiRouter.post('/class/join', async (req, res) => {
    const { className, studentEmail } = req.body;
     try {
        const classQuery = {
            query: "SELECT * FROM c WHERE c.className = @className",
            parameters: [{ name: "@className", value: className }]
        };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        if (classes.length === 0) {
            return res.status(404).json({ error: "Cette classe n'existe pas." });
        }
        const classDoc = classes[0];

        if (classDoc.students.includes(studentEmail)) {
            return res.status(409).json({ error: "Vous êtes déjà dans cette classe." });
        }
        
        classDoc.students.push(studentEmail);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);

        const { resource: studentDoc } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!studentDoc.classes) studentDoc.classes = [];
        studentDoc.classes.push(classDoc.id);
        await usersContainer.item(studentEmail, studentEmail).replace(studentDoc);

        res.status(200).json({ message: `Vous avez rejoint la classe ${className} !` });
    } catch (error) {
        res.status(500).json({ error: "Impossible de rejoindre la classe." });
    }
});

apiRouter.post('/class/assign-content', async (req, res) => {
    const { contentData, classId, teacherEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        const contentWithId = { 
            ...contentData, 
            id: `${contentData.type}-${Date.now()}`,
            assignedAt: new Date().toISOString() // Ajout de la date d'assignation
        };
        if(!classDoc.quizzes) classDoc.quizzes = [];
        classDoc.quizzes.push(contentWithId);
        await classesContainer.item(classId, teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Contenu assigné !" });
    } catch (e) { res.status(500).json({ error: "Impossible d'assigner le contenu." }); }
});

apiRouter.get('/student/classes/:studentEmail', async (req, res) => {
    const { studentEmail } = req.params;
    try {
        // 1. Récupérer l'élève et ses classes
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student || !student.classes || student.classes.length === 0) {
            return res.status(200).json([]);
        }

        // 2. Récupérer les contenus déjà terminés par l'élève
        const completedQuery = {
            query: "SELECT c.contentId, c.completedAt FROM c WHERE c.studentEmail = @studentEmail",
            parameters: [{ name: "@studentEmail", value: studentEmail }]
        };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedContentMap = new Map(completedItems.map(item => [item.contentId, item.completedAt]));

        // 3. Récupérer les classes de l'élève
        const classQuery = {
            query: `SELECT * FROM c WHERE ARRAY_CONTAINS(@classIds, c.id)`,
            parameters: [{ name: '@classIds', value: student.classes }]
        };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        let allQuizzes = [];

        // 4. Enrichir les contenus avec leur statut et les collecter
        const processedClasses = classes.map(cls => {
            if (cls.quizzes && cls.quizzes.length > 0) {
                cls.quizzes.forEach(quiz => {
                    if (completedContentMap.has(quiz.id)) {
                        quiz.status = 'completed';
                        quiz.completedAt = completedContentMap.get(quiz.id);
                    } else {
                        quiz.status = 'todo';
                    }
                    allQuizzes.push(quiz);
                });
            }
            return cls;
        });
        
        // 5. Identifier le contenu le plus récent pour le tag "NEW"
        if (allQuizzes.length > 0) {
            allQuizzes.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
            const newestQuiz = allQuizzes[0];
            if (newestQuiz.status !== 'completed') {
                 newestQuiz.isNewest = true;
            }
        }

        res.status(200).json(processedClasses);
    } catch (error) {
        console.error("Erreur détaillée:", error);
        res.status(500).json({ error: "Impossible de récupérer les classes de l'élève." });
    }
});


apiRouter.post('/quiz/submit', async (req, res) => {
    const { classId, quizId, studentEmail, score, totalQuestions, quizTitle, answers } = req.body;
    try {
        const classQuery = {
            query: "SELECT * FROM c WHERE c.id = @classId",
            parameters: [{ name: "@classId", value: classId }]
        };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        if (classes.length === 0) {
            return res.status(404).json({ error: "Classe non trouvée." });
        }
        const classDoc = classes[0];

        const newResult = {
            resultId: `result-${Date.now()}`,
            quizId,
            studentEmail,
            score,
            totalQuestions,
            quizTitle,
            answers,
            submittedAt: new Date().toISOString()
        };

        if (!classDoc.results) {
            classDoc.results = [];
        }
        classDoc.results.push(newResult);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);

        // Enregistrer que l'élève a terminé ce contenu
        const completedRecord = {
            studentEmail: studentEmail,
            contentId: quizId,
            completedAt: new Date().toISOString(),
            id: `${studentEmail}-${quizId}` // ID unique pour cet enregistrement
        };
        await completedContentContainer.items.upsert(completedRecord);


        res.status(200).json({ message: "Résultats enregistrés." });
    } catch (error) {
        res.status(500).json({ error: "Impossible d'enregistrer les résultats." });
    }
});

app.use('/api', apiRouter);
app.get('/', (req, res) => res.send('<h1>Le serveur AIDA est en ligne !</h1>'));

// --- 5. Démarrer le serveur ---
setupDatabase().then(containers => {
    usersContainer = containers.usersContainer;
    classesContainer = containers.classesContainer;
    completedContentContainer = containers.completedContentContainer; // Assigner le nouveau conteneur
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error);
    process.exit(1);
});

