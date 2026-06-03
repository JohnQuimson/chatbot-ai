const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Inizializzazione del client Supabase con controllo di sicurezza
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
   console.error("❌ ERRORE: Configurazione Supabase mancante nelle variabili d'ambiente!");
   process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

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

app.use(cors(corsOptions));

// =========================================================================
// FUNZIONE DI SUPPORTO: Genera embedding chiamando direttamente l'API v1
// =========================================================================
async function ottieniEmbeddingDiretto(testo, apiKey) {
   // Forziamo l'URL stabile v1 e il modello text-embedding-004
   const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${apiKey}`;

   const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
         content: { parts: [{ text: testo }] },
      }),
   });

   const data = await response.json();

   if (!response.ok) {
      throw new Error(data.error?.message || `Errore HTTP generico: ${response.status}`);
   }

   return data.embedding.values;
}

// =========================================================================
// ROTTA: Riceve il testo completo da WP, lo vettorizza e lo salva
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      const { testoCompleto, clienteKey, clienteId } = req.body;

      if (!testoCompleto || !clienteKey || !clienteId) {
         return res.status(400).json({ errore: 'Dati mancanti (richiesti: testoCompleto, clienteKey, clienteId).' });
      }

      // 1. CHUNKING: Dividiamo il testo in blocchi di circa 800 caratteri
      const chunk_size = 800;
      const regex = new RegExp(`.{1,${chunk_size}}(\\s|$)|.{1,${chunk_size}}`, 'g');
      const chunks = testoCompleto.match(regex) || [];

      // Svuota la vecchia documentazione di QUESTO specifico cliente per evitare duplicati
      await supabase.from('documenti_clienti').delete().eq('cliente_id', clienteId);

      const righeDaInserire = [];

      // 2. Generiamo l'embedding usando la nostra funzione fetch sicura
      for (const chunk of chunks) {
         const testoPulito = chunk.trim();
         if (testoPulito.length === 0) continue;

         const embeddingVettoriale = await ottieniEmbeddingDiretto(testoPulito, clienteKey);

         righeDaInserire.push({
            cliente_id: clienteId,
            contenuto: testoPulito,
            embedding: embeddingVettoriale,
         });
      }

      // 3. Salvataggio bulk su Supabase
      const { error } = await supabase.from('documenti_clienti').insert(righeDaInserire);
      if (error) throw error;

      res.json({
         successo: true,
         messaggio: `Documentazione sincronizzata. Generati ${righeDaInserire.length} blocchi.`,
      });
   } catch (error) {
      console.error('Errore durante il caricamento della documentazione:', error.message);
      res.status(500).json({ errore: `Errore interno durante la vettorizzazione: ${error.message}` });
   }
});

// =========================================================================
// ROTTA CHAT: Estrae solo il contesto utile da Supabase e risponde
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId } = req.body;

      if (!clienteKey || !clienteId || !messaggio) {
         return res.status(400).json({ errore: 'Dati in ingresso mancanti o vuoti.' });
      }

      // 1. Trasformiamo la domanda dell'utente in un vettore usando il fetch diretto
      const queryEmbedding = await ottieniEmbeddingDiretto(messaggio, clienteKey);

      // 2. Interroghiamo Supabase tramite la funzione SQL rpc
      const { data: documentiTrovati, error: dbError } = await supabase.rpc('cerca_documenti', {
         query_embedding: queryEmbedding,
         match_threshold: 0.2,
         match_count: 4,
         filtro_cliente: clienteId,
      });

      if (dbError) throw dbError;

      const contestoRistretto =
         documentiTrovati && documentiTrovati.length > 0
            ? documentiTrovati.map((doc) => doc.contenuto).join('\n\n')
            : 'Nessuna informazione specifica trovata nella documentazione.';

      // 3. Inizializziamo il modello di chat per la risposta testuale (qui l'SDK va benissimo)
      const genAI = new GoogleGenerativeAI(clienteKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

      const prompt = `Sei l'assistente IA ufficiale del sito. 
Rispondi in modo professionale basandoti esclusivamente sulle informazioni fornite qui sotto. 
Se la risposta non è presente nei dati, consiglia gentilmente di contattare l'assistenza umana.

INFORMAZIONI DI RIFERIMENTO PERTINENTI:
${contestoRistretto}

DOMANDA UTENTE:
${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error("Errore durante l'elaborazione della richiesta:", error.message);
      res.status(500).json({ errore: `Il server ha riscontrato un problema: ${error.message}` });
   }
});

// Homepage di controllo
app.get('/', (req, res) => {
   res.send('🚀 Gateway Multi-Cliente RAG con Fetch Diretto attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
