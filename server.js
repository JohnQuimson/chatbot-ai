const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Rotta per la chat multi-cliente
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, contestoPrivato } = req.body;

      // Validazione minima
      if (!clienteKey) {
         return res.status(400).json({ errore: "Manca l'API Key del cliente." });
      }
      if (!messaggio) {
         return res.status(400).json({ errore: 'Messaggio vuoto.' });
      }

      // Inizializziamo Gemini dinamicamente con la chiave del cliente
      const genAI = new GoogleGenerativeAI(clienteKey);

      // Usiamo il modello richiesto
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

      // Costruiamo il prompt usando il contesto inviato dal plugin WordPress
      const prompt = `Sei l'assistente IA ufficiale del sito. 
Rispondi in modo professionale basandoti esclusivamente sulle informazioni fornite qui sotto. 
Se la risposta non è presente nei dati, consiglia gentilmente di contattare l'assistenza umana.

INFORMAZIONI DI RIFERIMENTO:
${contestoPrivato || 'Nessuna istruzione specifica fornita.'}

DOMANDA UTENTE:
${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore durante la richiesta:', error.message);

      // Gestione errori specifica per chiavi non valide
      if (error.message.includes('API_KEY_INVALID')) {
         return res.status(401).json({ errore: 'API Key non valida.' });
      }

      res.status(500).json({ errore: 'Il server ha riscontrato un problema. Riprova.' });
   }
});

// Home page di cortesia
app.get('/', (req, res) => {
   res.send('🚀 Gateway Multi-Cliente per Gemini attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server Multi-Cliente pronto sulla porta ${PORT}`);
});
