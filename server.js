const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const pdf = require('pdf-parse'); // Importazione standard
const mammoth = require('mammoth');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURAZIONE GEMINI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Usiamo il modello che hai confermato funzionante
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

let conoscenzaIntegrata = '';

// FUNZIONE PER CARICARE TUTTI I DOCUMENTI
async function caricaDocumenti() {
   const directoryPath = path.join(__dirname, 'documentazione');

   // Se la cartella non esiste, la crea (evita crash)
   if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath);
      return 'Cartella documentazione creata. Aggiungi file per istruire il bot.';
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
            // Fix per il TypeError: gestisce sia esportazione diretta che .default
            const parsePdf = typeof pdf === 'function' ? pdf : pdf.default;
            const data = await parsePdf(dataBuffer);
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
   res.send('🚀 Server Online! In attesa di richieste su /chiedi');
});

app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio } = req.body;
      if (!messaggio) return res.status(400).json({ errore: 'Messaggio vuoto' });

      const prompt = `Sei l'assistente ufficiale di LD Marketplace. Rispondi basandoti ESCLUSIVAMENTE sulla documentazione fornita qui sotto. Se non trovi la risposta, dillo gentilmente.

DOCUMENTAZIONE DI RIFERIMENTO:
${conoscenzaIntegrata}

DOMANDA UTENTE:
${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore Gemini:', error.message);
      res.status(500).json({ errore: 'Il bot ha avuto un problema nel generare la risposta.' });
   }
});

// AVVIO SERVER DOPO CARICAMENTO DATI
const PORT = process.env.PORT || 10000;
caricaDocumenti().then((testo) => {
   conoscenzaIntegrata = testo;
   app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server pronto sulla porta ${PORT}`);
      console.log(`📝 Documentazione caricata: ${conoscenzaIntegrata.length} caratteri.`);
   });
});
