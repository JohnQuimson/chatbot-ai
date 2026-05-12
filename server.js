const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURAZIONE GEMINI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' }); // Usa il modello che preferisci, es: gemini-3.1-flash-lite

let conoscenzaIntegrata = '';

// FUNZIONE PER CARICARE TUTTI I DOCUMENTI
async function caricaDocumenti() {
   const directoryPath = path.join(__dirname, 'documentazione');

   if (!fs.existsSync(directoryPath)) {
      console.log('⚠️ Cartella documentazione non trovata, la creo...');
      fs.mkdirSync(directoryPath);
      return '';
   }

   const files = fs.readdirSync(directoryPath);
   let testoAccumulato = '';

   for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const ext = path.extname(file).toLowerCase();

      try {
         if (ext === '.txt') {
            console.log(`📖 Leggendo TXT: ${file}`);
            testoAccumulato += fs.readFileSync(filePath, 'utf8') + '\n';
         } else if (ext === '.pdf') {
            console.log(`📖 Leggendo PDF: ${file}`);
            const dataBuffer = fs.readFileSync(filePath);

            // FIX CRUCIALE: Gestione del pacchetto pdf-parse come funzione o oggetto
            let data;
            if (typeof pdf === 'function') {
               data = await pdf(dataBuffer);
            } else if (pdf.default && typeof pdf.default === 'function') {
               data = await pdf.default(dataBuffer);
            } else {
               throw new Error('Libreria pdf-parse non caricata correttamente');
            }

            testoAccumulato += data.text + '\n';
         } else if (ext === '.docx') {
            console.log(`📖 Leggendo WORD: ${file}`);
            const dataBuffer = fs.readFileSync(filePath);
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            testoAccumulato += result.value + '\n';
         }
      } catch (err) {
         console.error(`❌ Errore durante la lettura di ${file}:`, err.message);
      }
   }
   return testoAccumulato;
}

// ROTTE EXPRESS
app.get('/', (req, res) => {
   res.send('🚀 Chatbot Server Online!');
});

app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio } = req.body;
      if (!messaggio) return res.status(400).json({ errore: 'Messaggio vuoto' });

      const prompt = `Sei l'assistente ufficiale di LD Marketplace. Rispondi usando queste info.
        
DOCUMENTAZIONE:
${conoscenzaIntegrata}

DOMANDA: ${messaggio}`;

      const result = await model.generateContent(prompt);
      res.json({ risposta: result.response.text() });
   } catch (error) {
      console.error('Errore generazione:', error.message);
      res.status(500).json({ errore: 'Errore durante la risposta.' });
   }
});

// AVVIO DOPO CARICAMENTO
const PORT = process.env.PORT || 10000;
caricaDocumenti().then((testo) => {
   conoscenzaIntegrata = testo;
   app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server attivo sulla porta ${PORT}`);
      console.log(`📝 Conoscenza pronta (${conoscenzaIntegrata.length} caratteri)`);
   });
});
