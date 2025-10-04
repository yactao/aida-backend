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
app.use(express.static(path.join(__dirname, 'public')));


// --- 4. Définir les "Routes" ---
const apiRouter = express.Router();

// --- ROUTE DE SEEDING ROBUSTE ---
apiRouter.get('/seed-database', async (req, res) => {
    if (req.query.secret_key !== "aida-reset-2024") {
        return res.status(403).json({ error: "Accès non autorisé." });
    }

    try {
        console.log("Début du seeding de la base de données...");

        const { database } = await client.databases.createIfNotExists({ id: databaseId });
        console.log("Référence de la base de données obtenue.");

        console.log("Nettoyage des conteneurs...");
        await database.container(usersContainerId).delete().catch(e => console.log("Conteneur 'Users' non trouvé, suppression ignorée."));
        await database.container(classesContainerId).delete().catch(e => console.log("Conteneur 'Classes' non trouvé, suppression ignorée."));
        await database.container(completedContentContainerId).delete().catch(e => console.log("Conteneur 'CompletedContent' non trouvé, suppression ignorée."));
        
        console.log("Recréation des conteneurs...");
        const { container: newUsersContainer } = await database.containers.createIfNotExists({ id: usersContainerId, partitionKey: { paths: ["/email"] } });
        const { container: newClassesContainer } = await database.containers.createIfNotExists({ id: classesContainerId, partitionKey: { paths: ["/teacherEmail"] } });
        await database.containers.createIfNotExists({ id: completedContentContainerId, partitionKey: { paths: ["/studentEmail"] } });
        
        // Mettre à jour les références globales au cas où
        usersContainer = newUsersContainer;
        classesContainer = newClassesContainer;

        console.log("Conteneurs recréés.");

        const password = "password123";
        
        const firstNames = ["Léa", "Hugo", "Chloé", "Louis", "Manon", "Gabriel", "Emma", "Adam", "Camille", "Jules", "Alice", "Raphaël", "Louise", "Arthur", "Inès", "Lucas", "Lina", "Maël", "Jade", "Enzo", "Ambre", "Liam", "Anna", "Sacha", "Rose", "Tom", "Mila", "Ethan", "Zoé", "Noah"];
        const lastNames = ["Petit", "Durand", "Moreau", "Leroy", "Lefevre", "Roux", "Fournier", "Mercier", "Girard", "Lambert", "Bonnet", "Francois", "Martinez", "Legrand", "Garnier", "Faure", "Rousseau", "Blanc", "Guerin", "Muller", "Henry", "Simon", "Chevalier", "Denis", "Aubert", "Vidal", "Brunet", "Schmitt", "Meyer", "Barbier"];
        
        const teachers = [
            { firstName: "Nathalie", lastName: "Dubois", role: "teacher" },
            { firstName: "Karim", lastName: "Martin", role: "teacher" },
            { firstName: "Isabelle", lastName: "Bernard", role: "teacher" }
        ].map(t => ({...t, email: `${t.firstName.toLowerCase()}.${t.lastName.toLowerCase()}@aida.com`}));
        
        let students = Array.from({ length: 30 }, (_, i) => {
            const firstName = firstNames[i % firstNames.length];
            const lastName = lastNames[i % lastNames.length];
            return {
                firstName,
                lastName,
                email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@aida.com`, // Ajout d'un numéro pour unicité
                role: "student"
            };
        });

        const allUsers = [...teachers, ...students];
        
        console.log("Création des utilisateurs...");
        for (const user of allUsers) {
            await newUsersContainer.items.create({
                id: user.email,
                email: user.email,
                password: password,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName,
                classes: []
            });
        }
        console.log(`${allUsers.length} utilisateurs créés.`);

        console.log("Création des classes...");
        const classesData = [
            { name: "Classe de CP", teacher: teachers[0].email, students: students.slice(0, 10) },
            { name: "Classe de 6ème", teacher: teachers[1].email, students: students.slice(10, 20) },
            { name: "Classe de Seconde", teacher: teachers[2].email, students: students.slice(20, 30) }
        ];

        for (const classInfo of classesData) {
            const newClass = {
                id: `${classInfo.name.replace(/\s+/g, '-')}-${Date.now()}`,
                className: classInfo.name,
                teacherEmail: classInfo.teacher,
                students: classInfo.students.map(s => s.email),
                quizzes: [],
                results: []
            };
            await newClassesContainer.items.create(newClass);

            for (const student of classInfo.students) {
                 const { resource: studentDoc } = await newUsersContainer.item(student.email, student.email).read();
                 studentDoc.classes.push(newClass.id);
                 await newUsersContainer.item(student.email, student.email).replace(studentDoc);
            }
        }
        console.log(`${classesData.length} classes créées et élèves assignés.`);

        console.log("Seeding terminé avec succès !");
        res.status(200).send("<h1>La base de données a été réinitialisée avec les données de test !</h1><p>Vous pouvez maintenant retourner à l'application.</p>");

    } catch (error) {
        console.error("Erreur pendant le seeding:", error);
        res.status(500).json({ error: "Une erreur est survenue lors de la réinitialisation de la base de données.", details: error.message });
    }
});


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
        res.status(500).json({ error: "L'IA n'a pas pu générer d'explication." });
    }
});

// NOUVELLE ROUTE POUR L'AIDE CONTEXTUELLE
apiRouter.post('/aida/contextual-help', async (req, res) => {
    const { questionContext, userQuery } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    const prompt = `Un élève est bloqué sur la question de quiz suivante : "${questionContext}". Sa question est : "${userQuery}". Fournis-lui une explication pédagogique et un indice pour l'aider à trouver la réponse, mais sans jamais donner la réponse directement. Adresse-toi à lui de manière encourageante.`;

    try {
        const response = await axios.post('https://api.deepseek.com/chat/completions', {
            model: 'deepseek-chat',
            messages: [{ content: prompt, role: 'user' }]
        }, { headers: { 'Authorization': `Bearer ${apiKey}` } });
        
        const helpText = response.data.choices[0].message.content;
        res.json({ helpText });
    } catch (error) {
        res.status(500).json({ error: "AIDA n'a pas pu générer d'aide pour le moment." });
    }
});


apiRouter.post('/generate/content', async (req, res) => {
    const { competences, contentType } = req.body;
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Clé API non configurée." });

    let jsonPrompt, textPrompt;
    switch (contentType) {
        case 'exercices':
            jsonPrompt = `Crée 3 exercices variés avec correction sur: "${competences}". Format JSON: {"title": "Exercices sur ${competences}", "type": "exercices", "content": [{"enonce": "...", "correction": "..."}]}`;
            textPrompt = `Rédige 3 exercices clairs et variés avec leur correction détaillée sur la compétence suivante : "${competences}". Numérote chaque exercice. Sépare bien l'énoncé de la correction.`;
            break;
        case 'revision':
            jsonPrompt = `Crée une fiche de révision synthétique sur: "${competences}". Format JSON: {"title": "Fiche de révision : ${competences}", "type": "revision", "content": "..."}`;
            textPrompt = `Rédige une fiche de révision claire, concise et structurée sur la compétence : "${competences}". Utilise des titres et des points clés pour faciliter la lecture.`;
            break;
        case 'quiz':
        default:
            jsonPrompt = `Crée un quiz de 5 questions à 4 choix sur: "${competences}". Format JSON : {"title": "Quiz sur ${competences}", "type": "quiz", "questions": [{"question_text": "...", "options": ["A", "B", "C", "D"], "correct_answer_index": 0}]}`;
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
         case 'revision':
            prompt = `Convertis ce texte de fiche de révision en format JSON: {"title": "...", "type": "revision", "content": "..."}. TEXTE : "${text}"`;
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
            assignedAt: new Date().toISOString()
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
        const { resource: student } = await usersContainer.item(studentEmail, studentEmail).read();
        if (!student || !student.classes || student.classes.length === 0) {
            return res.status(200).json({ todo: [], completed: [] });
        }

        const completedQuery = {
            query: "SELECT c.contentId, c.completedAt FROM c WHERE c.studentEmail = @studentEmail",
            parameters: [{ name: "@studentEmail", value: studentEmail }]
        };
        const { resources: completedItems } = await completedContentContainer.items.query(completedQuery).fetchAll();
        const completedMap = new Map(completedItems.map(item => [item.contentId, item.completedAt]));

        const classQuery = {
            query: `SELECT * FROM c WHERE ARRAY_CONTAINS(@classIds, c.id)`,
            parameters: [{ name: '@classIds', value: student.classes }]
        };
        const { resources: classes } = await classesContainer.items.query(classQuery).fetchAll();
        
        let allContents = [];
        classes.forEach(cls => {
            if (cls.quizzes && cls.quizzes.length > 0) {
                cls.quizzes.forEach(content => {
                    allContents.push({ ...content, className: cls.className, classId: cls.id });
                });
            }
        });

        allContents.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
        const newestContentId = allContents.length > 0 ? allContents[0].id : null;

        const todo = [];
        const completed = [];

        allContents.forEach(content => {
            if (completedMap.has(content.id)) {
                completed.push({
                    ...content,
                    status: 'completed',
                    completedAt: completedMap.get(content.id)
                });
            } else {
                todo.push({
                    ...content,
                    status: 'new',
                    isNewest: content.id === newestContentId
                });
            }
        });
        
        completed.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

        res.status(200).json({ todo, completed });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Impossible de récupérer les données de l'élève." });
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
        const existingResultIndex = classDoc.results.findIndex(r => r.quizId === quizId && r.studentEmail === studentEmail);
        if (existingResultIndex > -1) {
            classDoc.results[existingResultIndex] = newResult;
        } else {
            classDoc.results.push(newResult);
        }
        await classesContainer.item(classDoc.id, classDoc.teacherEmail).replace(classDoc);

        const completedRecord = {
            studentEmail: studentEmail,
            contentId: quizId,
            completedAt: new Date().toISOString(),
            id: `${studentEmail}-${quizId}`
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
setupDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`\x1b[32m%s\x1b[0m`, `Serveur AIDA démarré sur le port ${PORT}`);
    });
}).catch(error => {
    console.error("\x1b[31m%s\x1b[0m", "[ERREUR CRITIQUE] Démarrage impossible.", error);
    process.exit(1);
});

