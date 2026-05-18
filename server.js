const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Funzione interna per leggere e ripulire la whitelist dal file di testo
function caricaWhitelist() {
   try {
      const filePath = path.join(__dirname, 'whitelist.txt');
      if (!fs.existsSync(filePath)) {
         fs.writeFileSync(filePath, '', 'utf-8');
         return [];
      }
      const data = fs.readFileSync(filePath, 'utf-8');
      return data
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0);
   } catch (error) {
      console.error('Errore durante la lettura di whitelist.txt:', error.message);
      return [];
   }
}

// Configurazione CORS con controllo dinamico basato sul file di testo
const corsOptions = {
   origin: function (origin, callback) {
      const whitelist = caricaWhitelist();
      if (!origin || whitelist.indexOf(origin) !== -1) {
         callback(null, true);
      } else {
         console.log(`🚫 Chiamata bloccata da CORS per l'origine: ${origin}`);
         callback(new Error('Dominio non autorizzato dal sistema di sicurezza.'));
      }
   },
};

// middleware CORS
app.use(cors(corsOptions));

// Rotta per la chat multi-cliente
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, contestoPrivato } = req.body;

      // Validazione
      if (!clienteKey) {
         return res.status(400).json({ errore: "Manca l'API Key del cliente." });
      }
      if (!messaggio) {
         return res.status(400).json({ errore: 'Messaggio vuoto.' });
      }

      // Inizializzazione Gemini con la chiave del cliente
      const genAI = new GoogleGenerativeAI(clienteKey);

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

// Homepage
app.get('/', (req, res) => {
   res.send('🚀 Gateway Multi-Cliente per Gemini attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server Multi-Cliente pronto sulla porta ${PORT}`);
});
