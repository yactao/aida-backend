// --- 1. Importations et Configuration ---
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const { CosmosClient } = require('@azure/cosmos');

// --- 2. Initialisation Cosmos DB ---
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const client = new CosmosClient({ endpoint, key });

const databaseId = 'AidaDB';
const usersContainerId = 'Users';
const classesContainerId = 'Classes';
const completedContentContainerId = 'CompletedContent';

let usersContainer, classesContainer, completedContentContainer;

async function setupDatabase() {
    const { database } = await client.databases.createIfNotExists({ id: databaseId });
    const { container: uc } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
    const { container: cc } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
    const { container: ccc } = await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });
    
    usersContainer = uc;
    classesContainer = cc;
    completedContentContainer = ccc;
    console.log("Base de données et conteneurs prêts.");
}

// --- 3. Initialisation Express ---
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiRouter = express.Router();

// --- 4. Routes API ---

// ... (Les routes d'authentification et de gestion des classes restent identiques)
// A. Authentification
apiRouter.post('/auth/signup', async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: "Email, mot de passe et rôle sont requis." });
    try {
        const { resource: existingUser } = await usersContainer.item(email, email).read().catch(() => ({ resource: null }));
        if (existingUser) return res.status(409).json({ error: "Cet email est déjà utilisé." });
        const nameParts = email.split('@')[0].split('.').map(part => part.charAt(0).toUpperCase() + part.slice(1));
        const firstName = nameParts[0] || "Nouvel";
        const lastName = nameParts[1] || "Utilisateur";
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

// B. Routes Professeur
apiRouter.get('/teacher/classes', async (req, res) => {
    const { teacherEmail } = req.query;
    if (!teacherEmail) return res.status(400).json({ error: "L'email de l'enseignant est requis." });
    const querySpec = { query: "SELECT * FROM c WHERE c.teacherEmail = @teacherEmail", parameters: [{ name: "@teacherEmail", value: teacherEmail }] };
    try {
        const { resources: classes } = await classesContainer.items.query(querySpec).fetchAll();
        res.status(200).json(classes);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les classes." }); }
});

apiRouter.post('/teacher/classes', async (req, res) => {
    const { className, teacherEmail } = req.body;
    if (!className || !teacherEmail) return res.status(400).json({ error: "Nom de classe et email du professeur sont requis." });
    const newClass = { id: `class-${Date.now()}`, className, teacherEmail, students: [], content: [], results: [] };
    try {
        const { resource: createdClass } = await classesContainer.items.create(newClass);
        res.status(201).json(createdClass);
    } catch (error) { res.status(500).json({ error: "Impossible de créer la classe." }); }
});

apiRouter.get('/teacher/classes/:classId', async (req, res) => {
    const { classId } = req.params;
    const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
    try {
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        res.status(200).json(resources[0]);
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer les détails de la classe." }); }
});

apiRouter.get('/teacher/classes/:classId/competency-report', async (req, res) => {
    const { classId } = req.params;
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        const classDoc = resources[0];
        const stats = {};
        (classDoc.results || []).forEach(result => {
            const content = (classDoc.content || []).find(c => c.id === result.contentId);
            if (content && content.competence && content.competence.competence) {
                const comp = content.competence.competence;
                if (!stats[comp]) {
                    stats[comp] = { scores: [], level: content.competence.level };
                }
                stats[comp].scores.push(result.score / result.totalQuestions);
            }
        });
        const report = Object.entries(stats).map(([competence, data]) => {
            const average = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
            return {
                competence,
                level: data.level,
                averageScore: Math.round(average * 100),
                studentCount: data.scores.length
            };
        });
        report.sort((a, b) => a.averageScore - b.averageScore);
        res.status(200).json(report);
    } catch (error) { res.status(500).json({ error: "Impossible de générer le rapport par compétence." }); }
});


apiRouter.post('/teacher/classes/:classId/add-student', async (req, res) => {
    const { classId } = req.params;
    const { studentEmail } = req.body;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });
    try {
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read().catch(() => ({ resource: null }));
        if (!student || student.role !== 'student') return res.status(404).json({ error: "Aucun élève trouvé avec cet email." });
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        const classDoc = resources[0];
        if (classDoc.students.includes(studentEmail)) return res.status(409).json({ error: "Cet élève est déjà dans la classe." });
        classDoc.students.push(studentEmail);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json({ message: "Élève ajouté avec succès." });
    } catch (error) { res.status(500).json({ error: "Impossible d'ajouter l'élève." }); }
});

apiRouter.post('/teacher/assign-content', async (req, res) => {
    const { classId, contentData } = req.body;
    if (!classId || !contentData) return res.status(400).json({ error: "ID de classe et contenu sont requis." });
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length === 0) return res.status(404).json({ error: "Classe non trouvée." });
        const classDoc = resources[0];
        const newContent = { ...contentData, id: `content-${Date.now()}`, assignedAt: new Date().toISOString() };
        if (!classDoc.content) classDoc.content = [];
        classDoc.content.push(newContent);
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        res.status(200).json(newContent);
    } catch (error) { res.status(500).json({ error: "Impossible d'assigner le contenu." }); }
});

// C. Routes Élève
apiRouter.get('/student/dashboard', async (req, res) => {
    const { studentEmail } = req.query;
    if (!studentEmail) return res.status(400).json({ error: "L'email de l'élève est requis." });
    try {
        const classQuery = { query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.students, @studentEmail)", parameters: [{ name: '@studentEmail', value: studentEmail }] };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        if (!classes || classes.length === 0) return res.status(200).json({ todo: [], completed: [] });
        const completedQuery = { query: "SELECT * FROM c WHERE c.studentEmail = @studentEmail", parameters: [{ name: "@studentEmail", value: studentEmail }] };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedMap = new Map(completedItems.map(item => [item.contentId, item.completedAt]));
        let allContent = [];
        classes.forEach(c => { (c.content || []).forEach(cont => allContent.push({ ...cont, className: c.className, classId: c.id })); });
        const todo = allContent.filter(cont => !completedMap.has(cont.id));
        const completed = allContent.filter(cont => completedMap.has(cont.id)).map(cont => ({ ...cont, completedAt: completedMap.get(cont.id) }));
        res.status(200).json({ todo, completed });
    } catch (error) { res.status(500).json({ error: "Impossible de récupérer le tableau de bord." }); }
});

apiRouter.post('/student/submit-quiz', async (req, res) => {
    const { studentEmail, classId, contentId, title, score, totalQuestions, answers } = req.body;
    if (!studentEmail || !classId || !contentId || score === undefined || !totalQuestions || !answers) {
        return res.status(400).json({ error: "Données de soumission incomplètes." });
    }
    const completedItem = { id: `${studentEmail}-${contentId}`, studentEmail, contentId, completedAt: new Date().toISOString() };
    await completedContentContainer.items.upsert(completedItem);
    try {
        const querySpec = { query: "SELECT * FROM c WHERE c.id = @classId", parameters: [{ name: "@classId", value: classId }] };
        const { resources } = await classesContainer.items.query(querySpec).fetchAll();
        if (resources.length > 0) {
            const classDoc = resources[0];
            const newResult = { studentEmail, contentId, title, score, totalQuestions, submittedAt: completedItem.completedAt, answers };
            if (!classDoc.results) classDoc.results = [];
            classDoc.results.push(newResult);
            await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);
        }
        res.status(201).json(completedItem);
    } catch (error) {
        res.status(500).json({ error: "Impossible de sauvegarder le résultat dans la classe." });
    }
});


// D. Routes IA
apiRouter.post('/ai/generate-content', async (req, res) => {
    const { competences, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    const promptMap = {
        quiz: `Crée un quiz de 3 questions à 4 choix sur: "${competences}". Le format doit être un JSON valide: {"title": "Quiz sur ${competences}", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`,
        exercices: `Crée une fiche de 2 exercices avec énoncé et correction sur: "${competences}". Le format doit être un JSON valide: {"title": "Exercices sur ${competences}", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}`,
        plan_de_lecon: `Crée un plan de leçon simple sur: "${competences}". Le format doit être un JSON valide: {"title": "Plan de leçon sur ${competences}", "type": "plan_de_lecon", "objectifs": ["Objectif 1", "Objectif 2"], "deroulement": "Étape 1...", "evaluation": "Comment évaluer les élèves"}`
    };
    const prompt = promptMap[contentType];
    if (!prompt) return res.status(400).json({ error: "Type de contenu non supporté." });
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        res.json({ structured_content: JSON.parse(jsonString) });
    } catch (error) { res.status(500).json({ error: "L'IA a généré une réponse invalide." }); }
});

apiRouter.post('/ai/get-hint', async (req, res) => {
    const { questionText } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !questionText) return res.status(400).json({ error: "Clé API et question requises." });
    const prompt = `Tu es un assistant pédagogique. Pour la question suivante : "${questionText}", donne un indice simple et court pour aider un élève à trouver la réponse, mais NE DONNE JAMAIS la réponse directement. Encourage l'élève.`;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "Erreur lors de la génération de l'indice." }); }
});

apiRouter.post('/ai/get-feedback-for-error', async (req, res) => {
    const { question, userAnswer, correctAnswer } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !question || !userAnswer || !correctAnswer) {
        return res.status(400).json({ error: "Données incomplètes pour le feedback." });
    }
    const prompt = `Tu es AIDA, une IA pédagogue et bienveillante. Un élève a fait une erreur à un quiz. Explique-lui simplement et gentiment pourquoi sa réponse est incorrecte et pourquoi la bonne réponse est juste. N'utilise pas de termes compliqués.
    - Question : "${question}"
    - Sa réponse (incorrecte) : "${userAnswer}"
    - La bonne réponse : "${correctAnswer}"`;
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ feedback: response.data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la génération du feedback." });
    }
});

// NOUVEAU : Route pour générer du contenu à partir d'un document/texte
apiRouter.post('/ai/generate-from-document', async (req, res) => {
    const { documentText, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !documentText || !contentType) {
        return res.status(400).json({ error: "Texte du document et type de contenu requis." });
    }

    const promptMap = {
        quiz: `À partir du texte suivant, crée un quiz de 3 questions à 4 choix pour vérifier la compréhension. Le format doit être un JSON valide: {"title": "Quiz sur le document", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}. Texte: "${documentText}"`,
        exercices: `À partir du texte suivant, crée une fiche de 2 exercices avec énoncé et correction. Le format doit être un JSON valide: {"title": "Exercices sur le document", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}. Texte: "${documentText}"`
    };

    const prompt = promptMap[contentType];
    if (!prompt) return res.status(400).json({ error: "Type de contenu non supporté." });

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', 
            { model: 'deepseek-chat', messages: [{ content: prompt, role: 'user' }] }, 
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        let jsonString = response.data.choices[0].message.content.replace(/```json\n|\n```/g, '');
        res.json({ structured_content: JSON.parse(jsonString) });
    } catch (error) { res.status(500).json({ error: "L'IA a généré une réponse invalide." }); }
});

// NOUVEAU : Route pour obtenir de l'aide sur un exercice
apiRouter.post('/ai/get-hint-from-document', async (req, res) => {
    const { exerciseText, userQuestion } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || !exerciseText || !userQuestion) {
        return res.status(400).json({ error: "Texte de l'exercice et question de l'élève requis." });
    }

    const prompt = `Tu es AIDA, un tuteur IA bienveillant. Un élève a besoin d'aide.
    Voici son exercice : "${exerciseText}".
    Voici sa question : "${userQuestion}".
    Analyse l'exercice et sa question, puis donne un indice utile, une explication simple ou un rappel de cours pour le guider. NE DONNE JAMAIS LA SOLUTION DIRECTEMENT. Sois encourageant.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions',
            { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] },
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );
        res.json({ hint: response.data.choices[0].message.content });
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de la génération de l'indice." });
    }
});


apiRouter.post('/ai/playground-chat', async (req, res) => {
    const { history } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });
    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', { model: 'deepseek-chat', messages: history }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        res.json({ reply: response.data.choices[0].message.content });
    } catch (error) { res.status(500).json({ error: "Erreur de communication avec AIDA." }); }
});

app.use('/api', apiRouter);
app.get('/', (req, res) => { res.send('<h1>Le serveur AIDA est en ligne et fonctionnel !</h1>'); });

// --- 5. Démarrage du serveur ---
const PORT = process.env.PORT || 3000;
setupDatabase().then(() => { app.listen(PORT, () => { console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`); });
}).catch(error => { console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error); process.exit(1); });

