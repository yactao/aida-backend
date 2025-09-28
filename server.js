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

app.use(cors()); 
app.use(express.json());

// --- 4. Définir les "Routes" ---
const apiRouter = express.Router();

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

// --- Les autres routes ---
apiRouter.post('/class/assign-content', async (req, res) => { /* ... */ });
apiRouter.post('/auth/signup', async (req, res) => { /* ... */ });
apiRouter.post('/auth/login', async (req, res) => { /* ... */ });
apiRouter.post('/classes/create', async (req, res) => { /* ... */ });
apiRouter.get('/classes/:teacherEmail', async (req, res) => { /* ... */ });
apiRouter.post('/class/join', async (req, res) => { /* ... */ });
apiRouter.get('/student/classes/:studentEmail', async (req, res) => { /* ... */ });
apiRouter.get('/class/details/:classId', async (req, res) => { /* ... */ });
apiRouter.post('/quiz/submit', async (req, res) => { /* ... */ });
apiRouter.post('/aida/chat', async (req, res) => { /* ... */ });
apiRouter.post('/aida/hint', async (req, res) => { /* ... */ });

app.use('/api', apiRouter);

// --- 5. Démarrer le serveur ---
setupDatabase().then(containers => {
    usersContainer = containers.usersContainer;
    classesContainer = containers.classesContainer;
    app.listen(PORT, () => console.log(`Serveur AIDA démarré sur le port ${PORT}`));
}).catch(error => {
    console.error("Démarrage impossible.", error);
    process.exit(1); // Arrête le serveur si la base de données n'est pas accessible
});

