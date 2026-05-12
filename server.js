const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PORT = process.env.PORT || 3000;

// Usiamo il modello che abbiamo appena visto essere disponibile nella tua lista
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const datiDocumento = fs.readFileSync('conoscenza.txt', 'utf8');

// Rotta per la chat
const express = require('express');
const app = express();
app.use(express.json());

app.post('/chiedi', async (req, res) => {
   try {
      const prompt = `INFO DI RIFERIMENTO: ${datiDocumento}\n\nDOMANDA: ${req.body.messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore:', error.message);
      res.status(500).json({ errore: 'Errore durante la generazione' });
   }
});

app.listen(PORT, () => console.log(`🚀 Server finalmente pronto su http://localhost:${PORT}`));
