// Funziona perfettamente, leggere documentazione pdf, txt e docx

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mammoth = require('mammoth');
const PDFParser = require('pdf2json'); // Nuova libreria
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

let conoscenzaIntegrata = '';

// Funzione specifica per leggere i PDF in modo asincrono
function parsePDF(filePath) {
   return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser(this, 1); // "1" estrae solo il testo senza formattazione pesante
      pdfParser.on('pdfParser_dataError', (errData) => reject(errData.parserError));
      pdfParser.on('pdfParser_dataReady', (pdfData) => {
         resolve(pdfParser.getRawTextContent());
      });
      pdfParser.loadPDF(filePath);
   });
}

async function caricaDocumenti() {
   const directoryPath = path.join(__dirname, 'documentazione');
   if (!fs.existsSync(directoryPath)) {
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
            testoAccumulato += fs.readFileSync(filePath, 'utf8') + '\n';
            console.log(`✅ TXT caricato: ${file}`);
         } else if (ext === '.docx') {
            const dataBuffer = fs.readFileSync(filePath);
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            testoAccumulato += result.value + '\n';
            console.log(`✅ DOCX caricato: ${file}`);
         } else if (ext === '.pdf') {
            const testoPdf = await parsePDF(filePath);
            testoAccumulato += testoPdf + '\n';
            console.log(`✅ PDF caricato: ${file}`);
         }
      } catch (err) {
         console.error(`❌ Errore su ${file}:`, err.message);
      }
   }
   return testoAccumulato;
}

// Rotta per la chat
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio } = req.body;
      const prompt = `Usa queste info per rispondere:\n${conoscenzaIntegrata}\n\nDomanda: ${messaggio}`;
      const result = await model.generateContent(prompt);
      res.json({ risposta: result.response.text() });
   } catch (error) {
      res.status(500).json({ errore: error.message });
   }
});

const PORT = process.env.PORT || 3000;
caricaDocumenti().then((testo) => {
   conoscenzaIntegrata = testo;
   app.listen(PORT, () => {
      console.log(`🚀 Server pronto su http://localhost:${PORT}`);
      console.log(`📚 Memoria bot: ${conoscenzaIntegrata.length} caratteri.`);
   });
});
