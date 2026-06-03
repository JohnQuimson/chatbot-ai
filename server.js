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

// Middleware CORS applicato globalmente
app.use(cors(corsOptions));

// =========================================================================
// NUOVA ROTTA: Riceve il testo completo da WP, lo vettorizza e lo salva
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      const { testoCompleto, clienteKey, clienteId } = req.body;

      if (!testoCompleto || !clienteKey || !clienteId) {
         return res.status(400).json({ errore: 'Dati mancanti (richiesti: testoCompleto, clienteKey, clienteId).' });
      }

      // 1. CHUNKING: Dividiamo il testo in blocchi di circa 800 caratteri senza tagliare le parole a metà
      const chunk_size = 800;
      const regex = new RegExp(`.{1,${chunk_size}}(\\s|$)|.{1,${chunk_size}}`, 'g');
      const chunks = testoCompleto.match(regex) || [];

      const genAI = new GoogleGenerativeAI(clienteKey, { apiVersion: 'v1' });
      // text-embedding-004 è il modello di Gemini per generare vettori (embeddings)
      const embeddingModel = genAI.getGenerativeModel({ model: 'embedding-001' });

      // Svuota l'eventuale vecchia documentazione di QUESTO specifico cliente per evitare duplicati
      await supabase.from('documenti_clienti').delete().eq('cliente_id', clienteId);

      const righeDaInserire = [];

      // 2. Generiamo l'embedding per ogni singolo blocco di testo
      for (const chunk of chunks) {
         const testoPulito = chunk.trim();
         if (testoPulito.length === 0) continue;

         // Chiamata all'API Gemini del cliente per ottenere il vettore del blocco
         const embedResult = await embeddingModel.embedContent(testoPulito);
         const embeddingVettoriale = embedResult.embedding.values;

         righeDaInserire.push({
            cliente_id: clienteId,
            contenuto: testoPulito,
            embedding: embeddingVettoriale,
         });
      }

      // 3. Salvataggio bulk (tutto in una volta) su Supabase
      const { error } = await supabase.from('documenti_clienti').insert(righeDaInserire);

      if (error) throw error;

      res.json({
         successo: true,
         messaggio: `Documentazione sincronizzata. Generati ${righeDaInserire.length} blocchi.`,
      });
   } catch (error) {
      console.error('Errore durante il caricamento della documentazione:', error.message);
      res.status(500).json({ errore: 'Errore interno durante la vettorizzazione dei dati.' });
   }
});

// =========================================================================
// ROTTA CHAT AGGIORNATA: Estrae solo il contesto utile da Supabase e risponde
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId } = req.body; // Ora serve clienteId al posto di contestoPrivato

      // Validazione input
      if (!clienteKey || !clienteId) {
         return res.status(400).json({ errore: "Mancano le credenziali o l'ID del cliente." });
      }
      if (!messaggio) {
         return res.status(400).json({ errore: 'Messaggio vuoto.' });
      }

      const genAI = new GoogleGenerativeAI(clienteKey, { apiVersion: 'v1' });

      // 1. Trasformiamo la domanda dell'utente in un vettore matematico
      const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
      const embedResult = await embeddingModel.embedContent(messaggio);
      const queryEmbedding = embedResult.embedding.values;

      // 2. Interroghiamo Supabase tramite la funzione SQL che abbiamo registrato prima
      const { data: documentiTrovati, error: dbError } = await supabase.rpc('cerca_documenti', {
         query_embedding: queryEmbedding,
         match_threshold: 0.2, // Soglia minima di somiglianza concettuale (0 = dissimile, 1 = identico)
         match_count: 4, // Recuperiamo al massimo i 4 blocchi più pertinenti
         filtro_cliente: clienteId,
      });

      if (dbError) throw dbError;

      // 3. Uniamo i blocchi di testo trovati in un'unica stringa di contesto
      const contestoRistretto =
         documentiTrovati && documentiTrovati.length > 0
            ? documentiTrovati.map((doc) => doc.contenuto).join('\n\n')
            : 'Nessuna informazione specifica trovata nella documentazione per questa richiesta.';

      // 4. Inizializziamo il modello di chat con il prompt ottimizzato
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

      if (error.message.includes('API_KEY_INVALID')) {
         return res.status(401).json({ errore: 'API Key non valida.' });
      }

      res.status(500).json({ errore: 'Il server ha riscontrato un problema. Riprova.' });
   }
});

// Homepage di controllo
app.get('/', (req, res) => {
   res.send('🚀 Gateway Multi-Cliente RAG con Supabase attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
