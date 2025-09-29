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
// ... existing code ...
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
// ... existing code ...
// ... existing code ...
apiRouter.get('/student/classes/:studentEmail', async (req, res) => {
    const { studentEmail } = req.params;
    try {
        // 1. Récupérer l'élève et ses classes
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student || !student.classes || student.classes.length === 0) {
            return res.status(200).json([]);
        }

        // 2. Récupérer les IDs des contenus déjà terminés par l'élève
        const completedQuery = {
            query: "SELECT c.contentId FROM c WHERE c.studentEmail = @studentEmail",
            parameters: [{ name: "@studentEmail", value: studentEmail }]
        };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedContentIds = completedItems.map(item => item.contentId);

        // 3. Récupérer les classes de l'élève
        const classQuery = {
            query: `SELECT * FROM c WHERE ARRAY_CONTAINS(@classIds, c.id)`,
            parameters: [{ name: '@classIds', value: student.classes }]
        };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        // 4. Filtrer les contenus pour ne pas inclure ceux déjà terminés
        const filteredClasses = classes.map(cls => {
            if (cls.quizzes && cls.quizzes.length > 0) {
                cls.quizzes = cls.quizzes.filter(quiz => !completedContentIds.includes(quiz.id));
            }
            return cls;
        });

        res.status(200).json(filteredClasses);
    } catch (error) {
        res.status(500).json({ error: "Impossible de récupérer les classes de l'élève." });
    }
});

apiRouter.post('/quiz/submit', async (req, res) => {
    const { classId, quizId, studentEmail, score, totalQuestions, quizTitle, answers } = req.body;
    try {
        const classQuery = {
// ... existing code ...
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
};

app.use('/api', apiRouter);
// ... existing code ...
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
