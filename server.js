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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

let conoscenzaIntegrata = '';

// Funzione magica per leggere tutto
async function caricaDocumenti() {
   const directoryPath = path.join(__dirname, 'documentazione');
   if (!fs.existsSync(directoryPath)) return 'Nessun documento trovato.';

   const files = fs.readdirSync(directoryPath);
   let testoAccumulato = '';

   for (const file of files) {
      const filePath = path.join(directoryPath, file);
      const ext = path.extname(file).toLowerCase();

      console.log(`📖 Leggendo: ${file}...`);

      if (ext === '.txt') {
         testoAccumulato += fs.readFileSync(filePath, 'utf8') + '\n';
      } else if (ext === '.pdf') {
         const dataBuffer = fs.readFileSync(filePath);
         const data = await pdf(dataBuffer);
         testoAccumulato += data.text + '\n';
      } else if (ext === '.docx') {
         const dataBuffer = fs.readFileSync(filePath);
         const result = await mammoth.extractRawText({ buffer: dataBuffer });
         testoAccumulato += result.value + '\n';
      }
   }
   return testoAccumulato;
}

// Avvio del server solo dopo aver letto i file
caricaDocumenti().then((testo) => {
   conoscenzaIntegrata = testo;
   const PORT = process.env.PORT || 10000;
   app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Bot online con documentazione caricata!`);
   });
});

app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio } = req.body;
      // Inseriamo tutta la conoscenza nel prompt
      const prompt = `Sei un assistente esperto. Usa le seguenti informazioni per rispondere.\n\nCONOSCENZA:\n${conoscenzaIntegrata}\n\nUTENTE: ${messaggio}`;

      const result = await model.generateContent(prompt);
      res.json({ risposta: result.response.text() });
   } catch (error) {
      console.error(error);
      res.status(500).json({ errore: 'Errore nella generazione.' });
   }
});
