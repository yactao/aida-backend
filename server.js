// --- 1. Importer les outils nécessaires ---
const express = require('express');
const cors = require('cors'); 
require('dotenv').config();
const axios = require('axios');
const { CosmosClient } = require('@azure/cosmos');

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

// --- ROUTE DE GÉNÉRATION DE CONTENU (MISE À JOUR) ---
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
        console.error("Erreur de l'IA:", error);
        res.status(500).json({ error: "L'IA a donné une réponse inattendue." }); 
    }
});

// --- NOUVELLE ROUTE POUR CONVERTIR LE TEXTE MODIFIÉ EN JSON ---
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
        console.error("Erreur de conversion IA:", error);
        res.status(500).json({ error: "Impossible de convertir le texte." });
    }
});


// --- Les autres routes restent inchangées ---
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
apiRouter.post('/auth/signup', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/auth/login', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/classes/create', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.get('/classes/:teacherEmail', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/class/join', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.get('/student/classes/:studentEmail', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.get('/class/details/:classId', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/quiz/submit', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/aida/chat', async (req, res) => { /* ... (inchangé) ... */ });
apiRouter.post('/aida/hint', async (req, res) => { /* ... (inchangé) ... */ });

app.use('/api', apiRouter);
app.get('/', (req, res) => res.send('<h1>Le serveur AIDA est en ligne !</h1>'));

// --- 5. Démarrer le serveur (inchangée) ---
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

