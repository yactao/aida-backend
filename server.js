// --- 1. Importer les outils nécessaires ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');

// --- 2. Configuration & Initialisation ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint, key });
const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

let usersContainer;
let classesContainer;
let completedContentContainer;

async function setupDatabase() {
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container: uc } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
    const { container: cc } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
    const { container: ccc } = await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });
    
    usersContainer = uc;
    classesContainer = cc;
    completedContentContainer = ccc;
    
    return { usersContainer, classesContainer, completedContentContainer };
}

// --- 3. Initialiser l'application ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// La ligne ci-dessous rend le dossier 'public' accessible
app.use(express.static(path.join(__dirname, 'public')));


// --- 4. Définir les "Routes" ---
const apiRouter = express.Router();

apiRouter.post('/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: "Email, mot de passe et rôle sont requis." });
    try {
        const { resource: existingUser } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (existingUser) return res.status(409).json({ error: "Cet email est déjà utilisé." });
        
        // On sépare le prénom/nom de l'email pour l'affichage
        const nameParts = email.split('@')[0].split('.');
        const firstName = nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1) : "Nouvel";
        const lastName = nameParts[1] ? nameParts[1].charAt(0).toUpperCase() + nameParts[1].slice(1) : "Utilisateur";

        const newUser = { id: email, email, password, role, classes: [], firstName, lastName };
        await usersContainer.items.create(newUser);
        res.status(201).json({ user: { email, role, firstName } });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la création du compte." }); }
});

apiRouter.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
     if (!email || !password) return res.status(400).json({ error: "Email et mot de passe sont requis." });
    try {
        const { resource: user } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (!user || user.password !== password) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
        res.status(200).json({ user: { email: user.email, role: user.role, firstName: user.firstName } });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la connexion." }); }
});

// --- Routes Professeur ---
apiRouter.get('/classes/:teacherEmail', async (req, res) => {
    const { teacherEmail } = req.params;
    const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.status(200).json(classes);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});

// ROUTE CORRIGÉE: Renvoie maintenant les données complètes pour l'affichage
apiRouter.get('/class/details/:classId', async (req, res) => {
    const { classId } = req.params;
     try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        
        const classDoc = resources[0];
        
        // On reconstruit l'objet que le front-end attend
        const studentsWithResults = (classDoc.students || []).map(studentEmail => {
            const studentResults = (classDoc.results || []).filter(r => r.studentEmail === studentEmail);
            return { email: studentEmail, results: studentResults };
        });

        res.status(200).json({ ...classDoc, studentsWithResults });

    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les détails de la classe." }); }
});

apiRouter.post('/classes/create', async (req, res) => {
    const { className, teacherEmail } = req.body;
    const newClass = { id: `${className.replace(/\s+/g, '-')}-${Date.now()}`, className, teacherEmail, students: [], quizzes: [], results: [] };
    try {
        await classesContainer.items.create(newClass);
        res.status(201).json(newClass);
    } catch (error) { res.status(500).json({ error: "Impossible de créer la classe." }); }
});

apiRouter.post('/class/assign-content', async (req, res) => {
    const { contentData, classId } = req.body;
    try {
        const classQuery = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }]};
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        if(classes.length === 0) return res.status(404).json({ error: "Classe non trouvée."});
        
        const classDoc = classes[0];
        const contentWithId = { ...contentData, id: `${contentData.type}-${Date.now()}`, assignedAt: new Date().toISOString() };
        if(!classDoc.quizzes) classDoc.quizzes = [];
        classDoc.quizzes.push(contentWithId);

        await classesContainer.item(classId, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Contenu assigné !" });
    } catch (e) { res.status(500).json({ error: "Impossible d'assigner le contenu." }); }
});

// --- Routes Élève ---
// ROUTE CORRIGÉE: Recherche les classes de l'élève de manière plus robuste
apiRouter.get('/student/classes/:studentEmail', async (req, res) => {
    const { studentEmail } = req.params;
    try {
        // On cherche toutes les classes où l'élève est listé
        const classQuery = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: '@studentEmail', value: studentEmail }] };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        if (!classes || classes.length === 0) {
            return res.status(200).json({ todo: [], completed: [] });
        }

        const completedQuery = { query: "SELECT * FROM c WHERE c.studentEmail = @studentEmail", parameters: [{ name: "@studentEmail", value: studentEmail }] };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedMap = new Map(completedItems.map(item => [item.contentId, item.completedAt]));

        let allContents = [];
        classes.forEach(cls => {
            (cls.quizzes || []).forEach(content => allContents.push({ ...content, className: cls.className, classId: cls.id }));
        });

        allContents.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
        const newestContentId = allContents.length > 0 ? allContents[0].id : null;

        const todo = allContents.filter(content => !completedMap.has(content.id))
                                .map(content => ({ ...content, status: 'new', isNewest: content.id === newestContentId }));
        const completed = allContents.filter(content => completedMap.has(content.id))
                                     .map(content => ({ ...content, status: 'completed', completedAt: completedMap.get(content.id) }))
                                     .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

        res.status(200).json({ todo, completed });
    } catch (error) {
        res.status(500).json({ error: "Impossible de récupérer les données de l'élève." });
    }
});

apiRouter.post('/quiz/submit', async (req, res) => {
    const { classId, quizId, studentEmail, score, totalQuestions, quizTitle, answers } = req.body;
    try {
        const classQuery = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        if (classes.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        
        const classDoc = classes[0];
        const newResult = { resultId: `result-${Date.now()}`, quizId, studentEmail, score, totalQuestions, quizTitle, answers, submittedAt: new Date().toISOString() };
        if (!classDoc.results) classDoc.results = [];
        classDoc.results.push(newResult);
        await classesContainer.item(classId, classDoc.teacherEmail).replace(classDoc);

        const completedRecord = { id: `${studentEmail}-${quizId}`, studentEmail, contentId: quizId, completedAt: new Date().toISOString() };
        await completedContentContainer.items.upsert(completedRecord);

        res.status(200).json({ message: "Résultats enregistrés." });
    } catch (error) { res.status(500).json({ error: "Impossible d'enregistrer les résultats." }); }
});

// --- Routes IA & Contenu ---
apiRouter.post('/generate/content', async (req, res) => {
    const { competences, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    const promptMap = {
        quiz: `Crée un quiz de 5 questions à 4 choix sur: "${competences}". Format JSON : {"title": "Quiz sur ${competences}", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`,
        exercices: `Crée 3 exercices variés avec correction sur: "${competences}". Format JSON: {"title": "Exercices sur ${competences}", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}`,
        revision: `Crée une fiche de révision synthétique sur: "${competences}". Format JSON: {"title": "Fiche de révision : ${competences}", "type": "revision", "content": "..."}`
    };
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ content: promptMap[contentType], role: 'user' }] }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        res.json({ structured_content: JSON.parse(jsonString) });
    } catch (error) { res.status(500).json({ error: "L'IA a donné une réponse inattendue." }); }
});

// Routes pour le Playground
apiRouter.post('/aida/chat', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: history }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ reply: response.data.choices[0].message.content });
    } catch(error) { res.status(500).json({ error: "Erreur de communication avec AIDA." }); }
});

apiRouter.post('/aida/hint', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    const hintRequest = [...history, { role: "user", content: "Donne-moi un indice pour répondre à ma dernière question, sans me donner la réponse." }];
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: hintRequest }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ hint: response.data.choices[0].message.content });
    } catch(error) { res.status(500).json({ error: "Impossible de générer un indice." }); }
});


app.use('/api', apiRouter);
app.get('/', (req, res) => res.send('<h1>Le serveur AIDA est en ligne !</h1>'));

// --- 5. Démarrer le serveur ---
setupDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error);
    process.exit(1);
});

