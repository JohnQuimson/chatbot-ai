const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const express = require('express');
const cors = require('cors'); // AGGIUNTO
require('dotenv').config();

const app = express();
// Abilitiamo CORS così WordPress può comunicare con Render
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PORT = process.env.PORT || 10000; // Render usa porte alte

// Modello corretto: 'gemini-1.5-flash' o 'gemini-2.0-flash-exp'
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const datiDocumento = fs.readFileSync('conoscenza.txt', 'utf8');

// Rotta di cortesia per testare il browser
app.get('/', (req, res) => {
   res.send('🚀 Server Chatbot Attivo!');
});

// Rotta per la chat
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio } = req.body;
      if (!messaggio) {
         return res.status(400).json({ errore: 'Messaggio mancante' });
      }

      const prompt = `INFO DI RIFERIMENTO: ${datiDocumento}\n\nDOMANDA: ${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore:', error.message);
      res.status(500).json({ errore: 'Errore durante la generazione' });
   }
});

// Importante: ascoltare su 0.0.0.0
app.listen(PORT, '0.0.0.0', () => {
   console.log(`🚀 Server in ascolto sulla porta ${PORT}`);
});
