const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Inizializzazione del client Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
   console.error('❌ ERRORE: Configurazione Supabase mancante!');
   process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Funzione interna per leggere la whitelist
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
      console.error('Errore lettura whitelist:', error.message);
      return [];
   }
}

// Configurazione CORS
app.use(
   cors({
      origin: function (origin, callback) {
         const whitelist = caricaWhitelist();
         if (!origin || whitelist.indexOf(origin) !== -1) {
            callback(null, true);
         } else {
            console.log(`🚫 Bloccato da CORS: ${origin}`);
            callback(new Error('Dominio non autorizzato.'));
         }
      },
   }),
);

// =========================================================================
// FUNZIONE DI SUPPORTO: Chiamata HTTP diretta senza bug di SDK
// =========================================================================
// =========================================================================
// FUNZIONE DI SUPPORTO: Chiamata HTTP diretta con il modello corretto
// =========================================================================
async function ottieniEmbeddingDiretto(testo, apiKey) {
   // Usiamo l'endpoint v1 con il modello ufficiale 'gemini-embedding-001'
   const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${apiKey}`;

   const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
         content: { parts: [{ text: testo }] },
      }),
   });

   const data = await response.json();

   if (!response.ok) {
      throw new Error(data.error?.message || `Errore HTTP: ${response.status}`);
   }

   if (!data.embedding?.values) {
      throw new Error('Risposta di embedding malformata da parte di Google.');
   }

   return data.embedding.values;
}

// =========================================================================
// ROTTA: Carica Documentazione (Con supporto al Prompt di Sistema dinamico)
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      // Riceviamo anche il "sistemaPrompt" inviato dal plugin WordPress
      const { clienteId, clienteKey, testoCompleto, sistemaPrompt } = req.body;

      if (!clienteId || !clienteKey || !testoCompleto) {
         return res.status(400).json({ errore: 'Dati mancanti.' });
      }

      // Pulizia dei caratteri decorativi inutili (===, ---, ecc.)
      const testoFiltrato = testoCompleto
         .replace(/={3,}/g, '')
         .replace(/-{3,}/g, '')
         .replace(/\*{3,}/g, '')
         .replace(/_{3,}/g, '')
         .replace(/\s+/g, ' ');

      // CHUNKING: Dividiamo il testo in blocchi da 800 caratteri
      const chunk_size = 800;
      const regex = new RegExp(`.{1,${chunk_size}}(\\s|$)|.{1,${chunk_size}}`, 'g');
      const chunks = testoFiltrato.match(regex) || [];

      const righeDaInserire = [];

      for (const chunk of chunks) {
         const testoPulito = chunk.trim();
         if (testoPulito.length === 0) continue;

         // Generazione del vettore (embedding) per il frammento di testo
         const embeddingVettoriale = await ottieniEmbeddingDiretto(testoPulito, clienteKey);

         righeDaInserire.push({
            cliente_id: clienteId,
            contenuto: testoPulito,
            embedding: embeddingVettoriale,
            sistema_prompt: sistemaPrompt || null, // Salviamo le regole del cliente in ogni riga
         });
      }

      // Salvataggio incrementale su Supabase
      if (righeDaInserire.length > 0) {
         const { error } = await supabase.from('documenti_clienti').insert(righeDaInserire);
         if (error) throw error;
      }

      res.json({
         successo: true,
         messaggio: `Documentazione sincronizzata. Generati ${righeDaInserire.length} blocchi.`,
      });
   } catch (error) {
      console.error('Errore caricamento documentazione:', error.message);
      res.status(500).json({ errore: error.message });
   }
});

// =========================================================================
// ROTTA CHAT: Risposta con Gemini 2.5 Flash ed estrazione regole dinamiche
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId } = req.body;

      if (!clienteKey || !clienteId || !messaggio) {
         return res.status(400).json({ errore: 'Dati in ingresso mancanti.' });
      }

      // Vettorizziamo la domanda dell'utente
      const queryEmbedding = await ottieniEmbeddingDiretto(messaggio, clienteKey);

      // Cerchiamo i blocchi di contesto più pertinenti su Supabase
      const { data: documentiTrovati, error: dbError } = await supabase.rpc('cerca_documenti', {
         query_embedding: queryEmbedding,
         match_threshold: 0.0, // Mantenuto a 0.0 come da tua configurazione
         match_count: 4,
         filtro_cliente: clienteId,
      });

      if (dbError) throw dbError;

      // 🔍 Recuperiamo il prompt di sistema memorizzato dal cliente dal database
      const rigaConPrompt = documentiTrovati?.find((d) => d.sistema_prompt && d.sistema_prompt.trim() !== '');

      // Se il cliente ha configurato delle regole usiamo quelle, altrimenti usiamo un comportamento standard di fallback
      const istruzioniSistemaDinamiche =
         rigaConPrompt && rigaConPrompt.sistema_prompt.trim() !== ''
            ? rigaConPrompt.sistema_prompt
            : 'Sei un assistente IA ufficiale del sito. Rispondi in modo professionale ed educato.';

      // Uniamo il testo dei documenti trovati per passarlo come documentazione
      const contestoRistretto =
         documentiTrovati && documentiTrovati.length > 0
            ? documentiTrovati.map((doc) => doc.contenuto).join('\n\n')
            : 'Nessuna informazione specifica trovata nella documentazione.';

      // Inizializziamo l'SDK di Google
      const genAI = new GoogleGenerativeAI(clienteKey);

      // Configura il modello passando le regole del cliente direttamente nel parametro nativo systemInstruction
      const model = genAI.getGenerativeModel({
         model: 'gemini-2.5-flash',
         systemInstruction: istruzioniSistemaDinamiche,
      });

      // Il prompt ora contiene solo il materiale di consultazione e la richiesta dell'utente
      const prompt = `DOCUMENTAZIONE AZIENDALE DI RIFERIMENTO:
${contestoRistretto}

DOMANDA DELL'UTENTE:
${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore richiesta chat:', error.message);
      res.status(500).json({ errore: error.message });
   }
});

app.get('/', (req, res) => {
   res.send('🚀 Gateway RAG multi-cliente stabile e attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
