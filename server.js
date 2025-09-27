// --- 1. Importer les outils nécessaires ---
const express = require('express');
const cors = require('cors'); 
require('dotenv').config();
const axios = require('axios');
const { CosmosClient } = require('@azure/cosmos');
const fs = require('fs').promises;
const path = require('path');

// --- 2. Configuration & Initialisation ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
if (!endpoint || !key) {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Variables COSMOS_ENDPOINT/COSMOS_KEY non définies.");
    process.exit(1);
}
const client = new CosmosClient({ endpoint, key });
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';

async function setupDatabase() {
  const { database } = await client.databases.createIfNotExists({ id: databaseId });
  const { container: usersContainer } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
  const { container: classesContainer } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
  return { usersContainer, classesContainer };
}

let usersContainer;
let classesContainer;

// --- 3. Initialiser l'application ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION CORS FINALE ET ROBUSTE POUR AZURE ---
// On définit explicitement l'unique origine autorisée.
const corsOptions = {
  origin: 'https://ecole20.netlify.app',
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE", // On autorise toutes les méthodes
  credentials: true,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions)); 

app.use(express.json());

// --- 4. Définir les "Routes" ---
// Le préfixe "/api" est ajouté ici pour toutes les routes.
const apiRouter = express.Router();

apiRouter.get('/programmes', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'programmes.json');
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        res.status(500).json({ error: "Impossible de charger les programmes." });
    }
});

apiRouter.post('/generate/quiz', async (req, res) => {
    const { competences } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    try {
        const prompt = `Tu es un assistant pédagogique. Crée un quiz de 5 questions à 4 choix pour des élèves de primaire, basé sur : "${competences}". Formate la réponse en JSON : {"title": "...", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`;
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let quizJsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        const quizData = JSON.parse(quizJsonString);
        res.json(quizData);
    } catch (error) { 
        res.status(500).json({ error: "L'IA a donné une réponse inattendue." }); 
    }
});

apiRouter.post('/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    try {
        const { resources: existing } = await usersContainer.items.query({ query: "SELECT * FROM c WHERE c.id = @email", parameters: [{ name: "@email", value: email }] }).fetchAll();
        if (existing.length > 0) return res.status(409).json({ error: "Cet email est déjà utilisé." });
        const newUser = { id: email, email, password, role, classes: [] };
        await usersContainer.items.create(newUser);
        res.status(201).json({ user: { email: newUser.email, role: newUser.role } });
    } catch (e) { res.status(500).json({ error: "Erreur serveur." }); }
});

apiRouter.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { resource: user } = await usersContainer.item(email, email).read();
        if (!user || user.password !== password) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        res.status(200).json({ user: { email: user.email, role: user.role, classes: user.classes || [] } });
    } catch (e) {
        if (e.code === 404) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        res.status(500).json({ error: "Erreur serveur." });
    }
});

apiRouter.post('/classes/create', async (req, res) => {
    const { className, teacherEmail } = req.body;
    const newClass = { id: `${className.replace(/\s+/g, '-')}-${Date.now()}`, className, teacherEmail, students: [], quizzes: [], results: [] };
    try {
        const { resource: created } = await classesContainer.items.create(newClass);
        res.status(201).json(created);
    } catch (e) { res.status(500).json({ error: "Impossible de créer la classe." }); }
});

apiRouter.get('/classes/:teacherEmail', async (req, res) => {
    const { teacherEmail } = req.params;
    try {
        const { resources: classes } = await classesContainer.items.query({ query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] }).fetchAll();
        res.status(200).json(classes);
    } catch (e) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});

apiRouter.post('/class/join', async (req, res) => {
    const { className, studentEmail } = req.body;
    try {
        const { resources: classes } = await classesContainer.items.query({ query: "SELECT * FROM c WHERE c.className = @className", parameters: [{ name: "@className", value: className }] }).fetchAll();
        if (classes.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        const classDoc = classes[0];
        if (!classDoc.students.includes(studentEmail)) {
            classDoc.students.push(studentEmail);
            await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        }
        const { resource: studentDoc } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!studentDoc.classes) studentDoc.classes = [];
        if (!studentDoc.classes.includes(classDoc.id)) {
            studentDoc.classes.push(classDoc.id);
            await usersContainer.item(studentEmail, studentEmail).replace(studentDoc);
        }
        res.status(200).json({ message: `Vous avez rejoint la classe ${classDoc.className} !` });
    } catch (e) { res.status(500).json({ error: "Impossible de rejoindre la classe." }); }
});
    
apiRouter.get('/student/classes/:studentEmail', async (req, res) => {
    const { studentEmail } = req.params;
    try {
        const { resource: studentDoc } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!studentDoc || !studentDoc.classes || !studentDoc.classes.length) return res.json([]);
        const { resources: classes } = await classesContainer.items.query({ query: "SELECT * FROM c WHERE ARRAY_CONTAINS(@classIds, c.id)", parameters: [{ name: '@classIds', value: studentDoc.classes }] }).fetchAll();
        res.status(200).json(classes);
    } catch (e) { res.status(500).json({ error: "Erreur serveur." }); }
});

apiRouter.post('/class/assign-quiz', async (req, res) => {
    const { quizData, classId, teacherEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        const quizWithId = { ...quizData, id: `quiz-${Date.now()}` };
        if(!classDoc.quizzes) classDoc.quizzes = [];
        classDoc.quizzes.push(quizWithId);
        await classesContainer.item(classId, teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Quiz assigné !" });
    } catch (e) { res.status(500).json({ error: "Impossible d'assigner le quiz." }); }
});
    
apiRouter.get('/class/details/:classId', async (req, res) => {
    const { classId } = req.params;
    try {
        const { resources: classes } = await classesContainer.items.query({ query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] }).fetchAll();
        if (classes.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        res.status(200).json(classes[0]);
    } catch (e) { res.status(500).json({ error: "Erreur serveur." }); }
});

apiRouter.post('/quiz/submit', async (req, res) => {
    const { classId, quizId, studentEmail, score, totalQuestions, quizTitle, answers } = req.body;
    try {
        const { resources: classes } = await classesContainer.items.query({ query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: '@classId', value: classId }] }).fetchAll();
        if (classes.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        const classDoc = classes[0];
        if (!classDoc.results) classDoc.results = [];
        const newResult = { resultId: `result-${Date.now()}`, quizId, quizTitle, studentEmail, score, totalQuestions, answers, date: new Date().toISOString() };
        classDoc.results.push(newResult);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Score enregistré !" });
    } catch (e) { 
        res.status(500).json({ error: "Impossible d'enregistrer le score." }); 
    }
});

apiRouter.post('/aida/help', async (req, res) => {
    const { question } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    try {
        const prompt = `Donne un indice simple pour un élève, sans donner la réponse. Question : "${question}"`;
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AIDA n'a pas pu fournir d'indice." }); }
});

apiRouter.post('/aida/feedback', async (req, res) => {
    const { question, wrongAnswer, correctAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    try {
        const prompt = `Pour un élève, explique simplement pourquoi "${wrongAnswer}" est incorrect pour la question "${question}", et pourquoi "${correctAnswer}" est la bonne réponse.`;
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ feedback: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "AIDA n'a pas pu fournir d'explication." }); }
});

// On utilise le routeur pour toutes les routes commençant par /api
app.use('/api', apiRouter);
app.get('/', (req, res) => res.send('<h1>Le serveur AIDA est en ligne !</h1>'));


// --- 5. Démarrer le serveur ---
setupDatabase().then((containers) => {
    usersContainer = containers.usersContainer;
    classesContainer = containers.classesContainer;
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] La connexion à la base de données a échoué.");
    console.error("Détail de l'erreur Cosmos DB:", error);
    process.exit(1);
});

