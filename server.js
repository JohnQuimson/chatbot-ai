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

async function ottieniEmbeddingDiretto(testo, apiKey) {
   // Uso l'endpoint v1 con il modello 'gemini-embedding-001'
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
// ROTTA: Cancella Documentazione Vecchia
// =========================================================================
app.post('/cancella-documentazione', async (req, res) => {
   try {
      const { clienteId } = req.body;

      if (!clienteId) {
         return res.status(400).json({ successo: false, errore: 'ID Cliente mancante.' });
      }

      console.log(`🗑️ Eliminazione documentazione precedente per il cliente: ${clienteId}`);

      // Elimina tutte le righe che corrispondono al clienteId corrente
      const { error } = await supabase.from('documenti_clienti').delete().eq('cliente_id', clienteId);

      if (error) throw error;

      res.json({
         successo: true,
         messaggio: `Memoria precedente svuotata con successo per il cliente ${clienteId}.`,
      });
   } catch (error) {
      console.error('Errore durante la cancellazione:', error.message);
      res.status(500).json({ successo: false, errore: error.message });
   }
});

// =========================================================================
// ROTTA: Carica Documentazione
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      // Riceviamo anche il "sistemaPrompt" inviato dal plugin WordPress
      const { clienteId, clienteKey, testoCompleto, sistemaPrompt } = req.body;

      if (!clienteId || !clienteKey || !testoCompleto) {
         return res.status(400).json({ errore: 'Dati mancanti.' });
      }

      // Pulizia dei caratteri inutili (===, ---, ecc.)
      const testoFiltrato = testoCompleto
         .replace(/={3,}/g, '')
         .replace(/-{3,}/g, '')
         .replace(/\*{3,}/g, '')
         .replace(/_{3,}/g, '')
         .replace(/\s+/g, ' ');

      // CHUNKING: Divisione del testo in blocchi da 800 caratteri
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
            sistema_prompt: sistemaPrompt || null,
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
// ROTTA CHAT: Risposta in STREAMING con Gemini 2.5 Flash + Cronologia
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId, cronologia } = req.body;

      if (!clienteKey || !clienteId || !messaggio) {
         return res.status(400).json({ errore: 'Dati in ingresso mancanti.' });
      }

      // 1. Configurazione degli Header per lo Streaming (Server-Sent Events)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // 2. Preleviamo il prompt di sistema di questo cliente
      const { data: righeCliente, error: promptError } = await supabase
         .from('documenti_clienti')
         .select('sistema_prompt')
         .eq('cliente_id', clienteId)
         .not('sistema_prompt', 'is', null)
         .filter('sistema_prompt', 'neq', '')
         .limit(1);

      if (promptError) console.error('[REGISTRO] Errore recupero prompt:', promptError.message);

      const basePrompt =
         righeCliente && righeCliente.length > 0 && righeCliente[0].sistema_prompt
            ? righeCliente[0].sistema_prompt
            : 'Sei un assistente IA ufficiale del sito. Rispondi in modo professionale ed educato.';

      // 3. RICERCA SEMANTICA (Embedding della sola domanda corrente)
      const queryEmbedding = await ottieniEmbeddingDiretto(messaggio, clienteKey);

      const { data: documentiTrovati, error: dbError } = await supabase.rpc('cerca_documenti', {
         query_embedding: queryEmbedding,
         match_threshold: 0.0,
         match_count: 4,
         filtro_cliente: clienteId,
      });

      if (dbError) throw dbError;

      const contestoRistretto =
         documentiTrovati && documentiTrovati.length > 0
            ? documentiTrovati.map((doc) => doc.contenuto).join('\n\n')
            : 'Nessuna informazione specifica trovata nella documentazione.';

      const istruzioniSistemaDinamiche = `${basePrompt}\n\nCONTESTO AZIENDALE DI RIFERIMENTO:\n${contestoRistretto}`;

      // =========================================================================
      // 4. COSTRUZIONE DELLA CRONOLOGIA (Iniezione sicura delle istruzioni v1)
      // =========================================================================
      let contents = [];

      // Inseriamo le istruzioni di sistema come messaggio iniziale "user" con risposta "model" di conferma.
      // Questo è il metodo più compatibile in assoluto con le API v1 stabili.
      contents.push({
         role: 'user',
         parts: [
            {
               text: `ISTRUZIONI DI SISTEMA IMPORTANTI:\n${istruzioniSistemaDinamiche}\n\nPrendi nota di queste istruzioni e applicale d'ora in avanti.`,
            },
         ],
      });
      contents.push({
         role: 'model',
         parts: [
            {
               text: 'Ho ricevuto le istruzioni di sistema e la documentazione aziendale. Sono pronto a rispondere agli utenti seguendo queste regole.',
            },
         ],
      });

      // Aggiungiamo il resto della cronologia dei messaggi precedenti (se esiste)
      if (cronologia && Array.isArray(cronologia) && cronologia.length > 0) {
         const ultimeInterazioni = cronologia.slice(-6);
         ultimeInterazioni.forEach((item) => {
            contents.push({
               role: item.ruolo === 'utente' ? 'user' : 'model',
               parts: [{ text: item.testo }],
            });
         });
      }

      // Infine aggiungiamo l'ultimo messaggio attuale dell'utente
      contents.push({
         role: 'user',
         parts: [{ text: messaggio }],
      });

      // =========================================================================
      // 5. INIZIALIZZAZIONE MODELLO GEMINI (Pulita per API v1)
      // =========================================================================
      const genAI = new GoogleGenerativeAI(clienteKey);
      const model = genAI.getGenerativeModel(
         {
            model: 'gemini-3.5-flash',
            generationConfig: { temperature: 0.4 },
         },
         { apiVersion: 'v1' },
      ); // Ora la v1 accetterà il payload al 100% perché è standard

      // =========================================================================
      // 6. ATTIVAZIONE DELLO STREAMING
      // =========================================================================
      const resultStream = await model.generateContentStream({
         contents: contents,
      });

      // Cicliamo sui frammenti di testo appena arrivano da Google e li inviamo al client
      for await (const chunk of resultStream.stream) {
         const chunkText = chunk.text();
         res.write(`data: ${JSON.stringify({ testo: chunkText })}\n\n`);
      }

      res.write(`data: [DONE]\n\n`);
      res.end();
   } catch (error) {
      console.error('❌ Errore nella chat streaming:', error.message);
      // Se c'è un errore, inviamo un messaggio speciale contrassegnato prima di chiudere
      res.write(
         `data: ${JSON.stringify({ errore: "Si è verificato un problema di connessione con il server dell'assistente." })}\n\n`,
      );
      res.end();
   }
});

app.get('/', (req, res) => {
   res.send('🚀 Gateway RAG multi-cliente stabile e attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
