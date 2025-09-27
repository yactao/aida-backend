// --- 1. Importer les outils nécessaires (inchangé) ---
const express = require('express');
const cors = require('cors'); 
require('dotenv').config();
const axios = require('axios');
const { CosmosClient } = require('@azure/cosmos');

// --- 2. Configuration & Initialisation (inchangée) ---
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

// --- 3. Initialiser l'application (inchangée) ---
const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin: 'https://ecole20.netlify.app',
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions)); 
app.use(express.json());

// --- 4. Définir les "Routes" ---
const apiRouter = express.Router();

// --- ROUTE DU CHAT MISE À JOUR ---
apiRouter.post('/aida/chat', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    if (!history || !Array.isArray(history)) {
        return res.status(400).json({ error: "Historique de conversation invalide." });
    }

    // On ajoute l'instruction de formatage dans le message système
    const formattedHistory = [...history];
    const systemMessage = formattedHistory.find(m => m.role === 'system');
    if (systemMessage) {
        systemMessage.content += " Quand tu donnes une liste ou des exercices, utilise des retours à la ligne (\\n) pour séparer chaque point. Ne numérote pas les exercices avec des étoiles. Utilise un format simple comme 'Exercice 1:'."
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: formattedHistory
        }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        res.json({ reply: response.data.choices[0].message.content });
    } catch (error) {
        console.error("Erreur de l'IA lors du chat:", error);
        res.status(500).json({ error: "AIDA n'a pas pu répondre." });
    }
});

// --- NOUVELLE ROUTE POUR LE BOUTON D'AIDE ---
apiRouter.post('/aida/playground-help', async (req, res) => {
    const { question, context } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    if (!question) {
        return res.status(400).json({ error: "Aucune question fournie pour l'indice." });
    }

    const prompt = `Tu es AIDA, une enseignante. Un élève est bloqué sur la question suivante : "${question}". En te basant sur le contexte de la conversation (${context}), donne-lui un indice simple pour le mettre sur la voie, sans jamais donner la réponse. Ta réponse doit être une seule phrase courte.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [{ role: "user", content: prompt }]
        }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) {
        console.error("Erreur de l'IA pour l'indice:", error);
        res.status(500).json({ error: "AIDA n'a pas pu trouver d'indice." });
    }
});


// --- Les autres routes restent inchangées ---
apiRouter.post('/generate/content', async (req, res) => {
    const { competences, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    let prompt;
    switch (contentType) {
        case 'exercices':
            prompt = `Tu es un assistant pédagogique. Crée 3 exercices d'application variés avec leur correction sur la compétence : "${competences}". Formate la réponse en JSON : {"title": "Exercices sur...", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}, ...]}`;
            break;
        case 'questions_ouvertes':
            prompt = `Tu es un assistant pédagogique. Crée 3 questions ouvertes qui font réfléchir un élève sur la compétence : "${competences}". Formate la réponse en JSON : {"title": "Questions sur...", "type": "questions_ouvertes", "content": ["Question 1...", "Question 2...", ...]}`;
            break;
        case 'fiche_revision':
            prompt = `Tu es un assistant pédagogique. Rédige une fiche de révision très claire, concise et structurée pour un élève sur la compétence : "${competences}". Formate la réponse en JSON : {"title": "Fiche de révision sur...", "type": "fiche_revision", "content": "Texte de la fiche..."}`;
            break;
        case 'quiz':
        default:
            prompt = `Tu es un assistant pédagogique. Crée un quiz de 5 questions à 4 choix pour des élèves, basé sur la compétence : "${competences}". Formate la réponse en JSON : {"title": "Quiz sur...", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`;
            break;
    }

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        const data = JSON.parse(jsonString);
        res.json(data);
    } catch (error) { 
        console.error("Erreur de l'IA:", error);
        res.status(500).json({ error: "L'IA a donné une réponse inattendue." }); 
    }
});
apiRouter.post('/class/assign-content', async (req, res) => {
    const { contentData, classId, teacherEmail } = req.body;
    try {
        const { resource: classDoc } = await classesContainer.item(classId, teacherEmail).read();
        const contentWithId = { ...contentData, id: `${contentData.type}-${Date.now()}` };
        if(!classDoc.quizzes) classDoc.quizzes = [];
        classDoc.quizzes.push(contentWithId);
        await classesContainer.item(classId, teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Contenu assigné !" });
    } catch (e) { res.status(500).json({ error: "Impossible d'assigner le contenu." }); }
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

app.use('/api', apiRouter);
app.get('/', (req, res) => res.send('<h1>Le serveur AIDA est en ligne !</h1>'));

// --- 5. Démarrer le serveur (inchangé) ---
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

